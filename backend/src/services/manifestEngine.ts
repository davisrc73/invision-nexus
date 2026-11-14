import crypto from 'node:crypto';
import { db } from '../config/database.js';

export type PriorityLevel = 'EXCLUSIVA' | 'PRIORITARIA' | 'NORMAL' | 'FALLBACK';

const PRIORITY_RANK: Record<PriorityLevel, number> = {
  EXCLUSIVA: 4,
  PRIORITARIA: 3,
  NORMAL: 2,
  FALLBACK: 1,
};

export interface ResolvedSequenceItem {
  sequence_index: number;
  media_asset_id: string;
  title: string;
  sha256_hash: string;
  file_size_bytes: number;
  duration_ms: number;
  scaling_policy: string;
  download_url: string;
}

/**
 * Calcula um atraso determinístico de download (Staggered Rollout Jitter)
 * baseado no UUID do dispositivo para espalhar 4.000 downloads ao longo da janela (ex: 0 a 900s).
 */
export function computeDeviceDownloadJitterSec(deviceId: string, maxWindowSec = 900): number {
  const hash = crypto.createHash('md5').update(deviceId).digest();
  const intVal = hash.readUInt32BE(0);
  return intVal % maxWindowSec;
}

/**
 * Gera sequência intercalada para Playlists em modo DYNAMIC_SOV (Share of Voice %)
 * usando Weighted Round-Robin para evitar repetição consecutiva do mesmo vídeo.
 */
export function buildDynamicSovLoop(
  items: Array<{
    media_asset_id: string;
    title: string;
    sha256_hash: string;
    file_size_bytes: number;
    duration_ms: number;
    scaling_policy: string;
    sov_percentage: number;
  }>,
  loopSize = 20
): ResolvedSequenceItem[] {
  if (items.length === 0) return [];

  const totalSov = items.reduce((acc, item) => acc + Number(item.sov_percentage || 10), 0);
  const buckets = items.map((item) => ({
    item,
    targetCount: Math.max(1, Math.round((Number(item.sov_percentage || 10) / totalSov) * loopSize)),
    currentWeight: 0,
    weightStep: Number(item.sov_percentage || 10) / totalSov,
  }));

  const totalSlots = buckets.reduce((acc, b) => acc + b.targetCount, 0);
  const sequence: ResolvedSequenceItem[] = [];

  for (let i = 0; i < totalSlots; i++) {
    let bestBucket = buckets[0];
    for (const b of buckets) {
      b.currentWeight += b.weightStep;
      if (b.currentWeight > bestBucket.currentWeight) {
        bestBucket = b;
      }
    }
    bestBucket.currentWeight -= 1.0;

    sequence.push({
      sequence_index: i + 1,
      media_asset_id: bestBucket.item.media_asset_id,
      title: bestBucket.item.title,
      sha256_hash: bestBucket.item.sha256_hash,
      file_size_bytes: Number(bestBucket.item.file_size_bytes),
      duration_ms: Number(bestBucket.item.duration_ms),
      scaling_policy: bestBucket.item.scaling_policy,
      download_url: `/api/v1/media/${bestBucket.item.media_asset_id}/stream`,
    });
  }

  return sequence;
}

/**
 * Compila o Manifesto completo para um Dispositivo específico:
 * 1. Filtra agendamentos que correspondem à Hierarquia (Insígnia, Região, Loja, Zona, SyncGroup, Categoria ou Device).
 * 2. Aplica a regra de Silenciamento Estrito: EXCLUSIVA > PRIORITARIA > NORMAL > FALLBACK.
 * 3. Inclui o Catálogo Interativo se o dispositivo for TV_DEMO.
 * 4. Calcula o ETag/Hash SHA-256 do manifesto e a janela de Staggered Rollout.
 */
export async function buildDeviceManifest(deviceId: string) {
  const devRes = await db.query(
    `SELECT d.id, d.name, d.device_category, d.interaction_mode, d.idle_timeout_sec,
            d.store_id, d.store_zone_id, d.sync_group_id, d.screen_profile_id,
            s.brand_id, s.region_id, s.opening_hours,
            sp.width_px, sp.height_px, sp.aspect_ratio, sp.orientation
     FROM devices d
     JOIN stores s ON s.id = d.store_id
     JOIN screen_profiles sp ON sp.id = d.screen_profile_id
     WHERE d.id = $1`,
    [deviceId]
  );

  if (devRes.rowCount === 0) {
    throw new Error('DEVICE_NOT_FOUND_OR_UNCONFIGURED');
  }

  const device = devRes.rows[0];

  // Procura todos os agendamentos válidos para este terminal
  const schedRes = await db.query(
    `SELECT sc.id AS schedule_id, sc.start_date, sc.end_date, sc.days_of_week,
            sc.daypart_start_time, sc.daypart_end_time, sc.pre_download_at,
            p.id AS playlist_id, p.name AS playlist_name, p.priority_level,
            p.scheduling_mode, p.total_slots, p.campaign_id
     FROM schedules sc
     JOIN playlists p ON p.id = sc.playlist_id
     WHERE p.is_active = TRUE
       AND p.brand_id = $1
       AND sc.end_date >= CURRENT_DATE
       AND (
         (sc.target_type = 'BRAND_ALL') OR
         (sc.target_type = 'REGION' AND sc.target_id = $2) OR
         (sc.target_type = 'STORE' AND sc.target_id = $3) OR
         (sc.target_type = 'STORE_ZONE' AND sc.target_id = $4) OR
         (sc.target_type = 'SYNC_GROUP' AND sc.target_id = $5) OR
         (sc.target_type = 'DEVICE_CATEGORY' AND sc.target_device_category = $6) OR
         (sc.target_type = 'DEVICE' AND sc.target_id = $7)
       )`,
    [
      device.brand_id,
      device.region_id,
      device.store_id,
      device.store_zone_id,
      device.sync_group_id,
      device.device_category,
      device.id,
    ]
  );

  // Determina a Prioridade Dominante Ativa (EXCLUSIVA silencia todas; PRIORITARIA silencia NORMAL)
  let highestActiveRank = 1; // FALLBACK default
  for (const row of schedRes.rows) {
    const rank = PRIORITY_RANK[row.priority_level as PriorityLevel] || 1;
    if (rank > highestActiveRank) {
      highestActiveRank = rank;
    }
  }

  const playlistsPayload = [];
  const requiredAssetsMap = new Map<
    string,
    { media_asset_id: string; sha256_hash: string; file_size_bytes: number; download_url: string }
  >();

  for (const row of schedRes.rows) {
    const itemsRes = await db.query(
      `SELECT pi.slot_position, pi.sov_percentage, pi.custom_duration_ms, pi.scaling_policy,
              m.id AS media_asset_id, m.title, m.sha256_hash, m.file_size_bytes, m.duration_ms
       FROM playlist_items pi
       JOIN media_assets m ON m.id = pi.media_asset_id
       WHERE pi.playlist_id = $1
         AND m.brand_id = $2
         AND (m.valid_until IS NULL OR m.valid_until > NOW())
       ORDER BY pi.slot_position ASC NULLS LAST, pi.created_at ASC`,
      [row.playlist_id, device.brand_id]
    );

    const rawItems = itemsRes.rows.map((it) => ({
      media_asset_id: it.media_asset_id,
      title: it.title,
      sha256_hash: it.sha256_hash,
      file_size_bytes: Number(it.file_size_bytes),
      duration_ms: Number(it.custom_duration_ms || it.duration_ms),
      scaling_policy: it.scaling_policy,
      slot_position: it.slot_position,
      sov_percentage: Number(it.sov_percentage || 0),
    }));

    for (const it of rawItems) {
      requiredAssetsMap.set(it.media_asset_id, {
        media_asset_id: it.media_asset_id,
        sha256_hash: it.sha256_hash,
        file_size_bytes: it.file_size_bytes,
        download_url: `/api/v1/media/${it.media_asset_id}/stream`,
      });
    }

    const resolvedLoop: ResolvedSequenceItem[] =
      row.scheduling_mode === 'DYNAMIC_SOV'
        ? buildDynamicSovLoop(rawItems)
        : rawItems.map((it, idx) => ({
            sequence_index: it.slot_position || idx + 1,
            media_asset_id: it.media_asset_id,
            title: it.title,
            sha256_hash: it.sha256_hash,
            file_size_bytes: it.file_size_bytes,
            duration_ms: it.duration_ms,
            scaling_policy: it.scaling_policy,
            download_url: `/api/v1/media/${it.media_asset_id}/stream`,
          }));

    playlistsPayload.push({
      schedule_id: row.schedule_id,
      playlist_id: row.playlist_id,
      playlist_name: row.playlist_name,
      campaign_id: row.campaign_id,
      priority_level: row.priority_level,
      priority_rank: PRIORITY_RANK[row.priority_level as PriorityLevel] || 1,
      silences_lower_priorities: true, // Regra de negócio confirmada: EXCLUSIVA e PRIORITARIA silenciam níveis inferiores a 100%
      scheduling_mode: row.scheduling_mode,
      window: {
        start_date: row.start_date,
        end_date: row.end_date,
        days_of_week: row.days_of_week,
        daypart_start_time: row.daypart_start_time,
        daypart_end_time: row.daypart_end_time,
        pre_download_at: row.pre_download_at,
      },
      sequence: resolvedLoop,
    });
  }

  // Se o dispositivo for TV_DEMO ou INTERACTIVE_CATALOG, anexa o catálogo de demonstração por categorias
  let tvDemoCatalog: any[] = [];
  if (device.device_category === 'TV_DEMO' || device.interaction_mode === 'INTERACTIVE_CATALOG') {
    const catRes = await db.query(
      `SELECT c.id AS category_id, c.name AS category_name, c.icon_name,
              i.highlight_specs, m.id AS media_asset_id, m.title, m.sha256_hash,
              m.file_size_bytes, m.duration_ms
       FROM tv_demo_categories c
       JOIN tv_demo_items i ON i.category_id = c.id
       JOIN media_assets m ON m.id = i.media_asset_id
       WHERE c.brand_id = $1
       ORDER BY c.display_order ASC, i.display_order ASC`,
      [device.brand_id]
    );

    tvDemoCatalog = catRes.rows;
    for (const item of catRes.rows) {
      requiredAssetsMap.set(item.media_asset_id, {
        media_asset_id: item.media_asset_id,
        sha256_hash: item.sha256_hash,
        file_size_bytes: Number(item.file_size_bytes),
        download_url: `/api/v1/media/${item.media_asset_id}/stream`,
      });
    }
  }

  const maxStaggerSec = Number(process.env.STAGGER_WINDOW_MAX_SEC || 900);
  const manifestCore = {
    device: {
      id: device.id,
      name: device.name,
      category: device.device_category,
      interaction_mode: device.interaction_mode,
      idle_timeout_sec: device.idle_timeout_sec,
      sync_group_id: device.sync_group_id,
      opening_hours: device.opening_hours,
      screen_profile: {
        width_px: device.width_px,
        height_px: device.height_px,
        aspect_ratio: device.aspect_ratio,
        orientation: device.orientation,
      },
    },
    rollout_policy: {
      stagger_delay_sec: computeDeviceDownloadJitterSec(device.id, maxStaggerSec),
      max_concurrent_downloads: 2,
      supports_http_range: true,
    },
    dominant_priority_rank: highestActiveRank,
    playlists: playlistsPayload,
    tv_demo_catalog: tvDemoCatalog,
    required_assets: Array.from(requiredAssetsMap.values()),
  };

  const manifestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(manifestCore))
    .digest('hex');

  return {
    manifest_hash: manifestHash,
    generated_at: new Date().toISOString(),
    ...manifestCore,
  };
}

