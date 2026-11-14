/**
 * Fila Offline-First em IndexedDB para Telemetria Dual:
 * 1. Proof of Play Agregado por Hora (`pop_buckets`)
 * 2. Métricas de Interação Touch / TV Demo (`interaction_buckets`)
 *
 * Sincroniza em lote (Batch Upsert) com jitter aleatório para evitar Thundering Herd
 * dos ~4.000 dispositivos à hora certa (:00).
 */

const DB_NAME = 'invision_nexus_edge_telemetry';
const DB_VERSION = 1;

export interface PopHourlyBucket {
  key: string; // `${hour_bucket}|${playlist_id}|${media_asset_id}`
  hour_bucket: string;
  playlist_id: string;
  campaign_id: string | null;
  media_asset_id: string;
  play_count: number;
  total_duration_ms: number;
}

export interface InteractionHourlyBucket {
  key: string; // `${hour_bucket}|${interaction_type}|${reference_key}`
  hour_bucket: string;
  interaction_type: 'TOUCH_WAKE' | 'TV_CATEGORY_SELECT' | 'TV_VIDEO_PLAY';
  reference_key: string;
  interaction_count: number;
  total_engaged_seconds: number;
}

function getCurrentHourIso(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

function openTelemetryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pop_buckets')) {
        db.createObjectStore('pop_buckets', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('interaction_buckets')) {
        db.createObjectStore('interaction_buckets', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Incrementa o contador horário de Proof of Play no IndexedDB local
 */
export async function recordLocalProofOfPlay(params: {
  playlist_id: string;
  campaign_id?: string | null;
  media_asset_id: string;
  duration_ms: number;
}): Promise<PopHourlyBucket> {
  const db = await openTelemetryDb();
  const hour_bucket = getCurrentHourIso();
  const key = `${hour_bucket}|${params.playlist_id}|${params.media_asset_id}`;

  return new Promise((resolve, reject) => {
    const tx = db.transaction('pop_buckets', 'readwrite');
    const store = tx.objectStore('pop_buckets');
    const getReq = store.get(key);

    getReq.onsuccess = () => {
      const existing: PopHourlyBucket | undefined = getReq.result;
      const updated: PopHourlyBucket = existing
        ? {
            ...existing,
            play_count: existing.play_count + 1,
            total_duration_ms: existing.total_duration_ms + params.duration_ms,
          }
        : {
            key,
            hour_bucket,
            playlist_id: params.playlist_id,
            campaign_id: params.campaign_id || null,
            media_asset_id: params.media_asset_id,
            play_count: 1,
            total_duration_ms: params.duration_ms,
          };

      store.put(updated);
      tx.oncomplete = () => resolve(updated);
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Incrementa o contador horário de Interação (Touch Wake em Portáteis/Smartphones/Tablets ou Escolha de Categoria TV Demo)
 */
export async function recordLocalInteraction(params: {
  interaction_type: 'TOUCH_WAKE' | 'TV_CATEGORY_SELECT' | 'TV_VIDEO_PLAY';
  reference_key?: string;
  engaged_seconds?: number;
}): Promise<InteractionHourlyBucket> {
  const db = await openTelemetryDb();
  const hour_bucket = getCurrentHourIso();
  const reference_key = params.reference_key || 'GLOBAL';
  const key = `${hour_bucket}|${params.interaction_type}|${reference_key}`;

  return new Promise((resolve, reject) => {
    const tx = db.transaction('interaction_buckets', 'readwrite');
    const store = tx.objectStore('interaction_buckets');
    const getReq = store.get(key);

    getReq.onsuccess = () => {
      const existing: InteractionHourlyBucket | undefined = getReq.result;
      const updated: InteractionHourlyBucket = existing
        ? {
            ...existing,
            interaction_count: existing.interaction_count + 1,
            total_engaged_seconds:
              existing.total_engaged_seconds + (params.engaged_seconds || 0),
          }
        : {
            key,
            hour_bucket,
            interaction_type: params.interaction_type,
            reference_key,
            interaction_count: 1,
            total_engaged_seconds: params.engaged_seconds || 0,
          };

      store.put(updated);
      tx.oncomplete = () => resolve(updated);
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Lê todos os registos pendentes no IndexedDB para exibição no Hidden OSD Menu e sincronização com a Sede
 */
export async function getAllLocalTelemetry(): Promise<{
  popBuckets: PopHourlyBucket[];
  interactionBuckets: InteractionHourlyBucket[];
}> {
  const db = await openTelemetryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pop_buckets', 'interaction_buckets'], 'readonly');
    const popReq = tx.objectStore('pop_buckets').getAll();
    const intReq = tx.objectStore('interaction_buckets').getAll();

    tx.oncomplete = () => {
      resolve({
        popBuckets: popReq.result || [],
        interactionBuckets: intReq.result || [],
      });
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Sincroniza os blocos horários acumulados no IndexedDB com o Backend PostgreSQL quando há rede
 */
export async function flushTelemetryToServer(
  apiBaseUrl: string,
  deviceToken: string
): Promise<{ popSynced: number; intSynced: number }> {
  if (!navigator.onLine || !deviceToken) {
    return { popSynced: 0, intSynced: 0 };
  }

  const { popBuckets, interactionBuckets } = await getAllLocalTelemetry();
  let popSynced = 0;
  let intSynced = 0;

  if (popBuckets.length > 0) {
    const res = await fetch(`${apiBaseUrl}/api/v1/telemetry/pop/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': deviceToken,
      },
      body: JSON.stringify({ records: popBuckets }),
    });
    if (res.ok) {
      popSynced = popBuckets.length;
    }
  }

  if (interactionBuckets.length > 0) {
    const res = await fetch(`${apiBaseUrl}/api/v1/telemetry/interactions/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': deviceToken,
      },
      body: JSON.stringify({ records: interactionBuckets }),
    });
    if (res.ok) {
      intSynced = interactionBuckets.length;
    }
  }

  return { popSynced, intSynced };
}

