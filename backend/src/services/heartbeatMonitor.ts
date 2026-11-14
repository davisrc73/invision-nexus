import { db, redis } from '../config/database.js';

const EXPO_CATEGORIES = new Set(['LAPTOP_EXPO', 'TABLET_EXPO', 'SMARTPHONE_EXPO', 'TV_DEMO']);

/**
 * Verifica se a Loja está dentro do seu horário de funcionamento (`opening_hours`).
 * Fora do horário da loja, dispositivos de bancada (Portáteis, Tablets, Smartphones) têm a energia desligada,
 * pelo que o sistema suprime falsos alertas de OFFLINE para a equipa de IT.
 */
export function isStoreCurrentlyOpen(openingHours: {
  open?: string;
  close?: string;
  days?: number[];
}): boolean {
  const now = new Date();
  const isoDay = now.getDay() === 0 ? 7 : now.getDay(); // 1 (Seg) .. 7 (Dom)
  const allowedDays = openingHours?.days || [1, 2, 3, 4, 5, 6, 7];

  if (!allowedDays.includes(isoDay)) {
    return false;
  }

  const currentHm = now.toTimeString().slice(0, 5); // "HH:MM"
  const openHm = openingHours?.open || '09:00';
  const closeHm = openingHours?.close || '23:00';

  return currentHm >= openHm && currentHm <= closeHm;
}

/**
 * Regista um Heartbeat leve (60s) no Redis e atualiza o estado em PostgreSQL
 */
export async function recordDeviceHeartbeat(payload: {
  device_id: string;
  storage_free_bytes: number;
  current_manifest_hash?: string;
  app_version?: string;
}) {
  const ttlSec = Number(process.env.HEARTBEAT_TIMEOUT_SEC || 180); // 3 falhas de 60s = 180s

  try {
    await redis.set(
      `hb:device:${payload.device_id}`,
      JSON.stringify({ ts: Date.now(), ...payload }),
      'EX',
      ttlSec
    );
  } catch {
    // Fallback resiliente caso o Redis esteja a reiniciar
  }

  await db.query(
    `UPDATE devices
     SET status = 'ONLINE',
         last_seen_at = NOW(),
         storage_free_bytes = $2,
         current_manifest_hash = COALESCE($3, current_manifest_hash),
         app_version = COALESCE($4, app_version)
     WHERE id = $1`,
    [
      payload.device_id,
      payload.storage_free_bytes,
      payload.current_manifest_hash || null,
      payload.app_version || null,
    ]
  );

  // Devolve comandos remotos pendentes (REBOOT, CLEAR_CACHE, FORCE_SYNC, KILL_SWITCH)
  const cmdRes = await db.query(
    `UPDATE device_commands
     SET status = 'DELIVERED', executed_at = NOW()
     WHERE id IN (
       SELECT id FROM device_commands
       WHERE device_id = $1 AND status = 'PENDING'
       ORDER BY created_at ASC
       LIMIT 5
     )
     RETURNING id, command_type, payload`,
    [payload.device_id]
  );

  return cmdRes.rows;
}

/**
 * Worker periódico (corre a cada 60s):
 * Marca como OFFLINE dispositivos sem heartbeat há > 180s,
 * mas suprime alertas em equipamentos de exposição fora do horário da loja.
 */
export async function evaluateOfflineDevices(): Promise<{
  markedOffline: number;
  suppressedAfterHours: number;
}> {
  const timeoutSec = Number(process.env.HEARTBEAT_TIMEOUT_SEC || 180);

  const staleRes = await db.query(
    `SELECT d.id, d.device_category, s.opening_hours
     FROM devices d
     JOIN stores s ON s.id = d.store_id
     WHERE d.status = 'ONLINE'
       AND d.last_seen_at < NOW() - ($1 || ' seconds')::INTERVAL`,
    [timeoutSec]
  );

  let markedOffline = 0;
  let suppressedAfterHours = 0;

  for (const row of staleRes.rows) {
    const isExpoDevice = EXPO_CATEGORIES.has(row.device_category);
    const storeOpen = isStoreCurrentlyOpen(row.opening_hours);

    await db.query(`UPDATE devices SET status = 'OFFLINE' WHERE id = $1`, [row.id]);
    markedOffline++;

    if (isExpoDevice && !storeOpen) {
      suppressedAfterHours++;
    }
  }

  return { markedOffline, suppressedAfterHours };
}

