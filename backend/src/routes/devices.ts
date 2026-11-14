import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../config/database.js';
import { authenticateDevice, requireRoles } from '../middleware/rbac.js';
import { buildDeviceManifest } from '../services/manifestEngine.js';
import { recordDeviceHeartbeat, isStoreCurrentlyOpen } from '../services/heartbeatMonitor.js';

export async function deviceRoutes(app: FastifyInstance) {
  /**
   * 1. ZERO-TOUCH PAIRING: O Player arranca e pede um código de 6 dígitos (ex: NX-849201)
   */
  app.post('/api/v1/devices/pairing/request', async (request, reply) => {
    const schema = z.object({
      hardware_uid: z.string().min(4),
      device_category: z
        .enum(['ANDROID_BOX', 'LEDWALL', 'TV_DEMO', 'LAPTOP_EXPO', 'TABLET_EXPO', 'SMARTPHONE_EXPO'])
        .default('ANDROID_BOX'),
      app_version: z.string().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_PAIRING_REQUEST', details: parsed.error.flatten() });
    }

    const { hardware_uid, device_category, app_version } = parsed.data;
    const randomDigits = crypto.randomInt(100000, 999999);
    const pairingCode = `NX-${randomDigits}`;

    const res = await db.query(
      `INSERT INTO devices (hardware_uid, device_category, pairing_code, pairing_expires_at, app_version, status)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', $4, 'PENDING_APPROVAL')
       ON CONFLICT (hardware_uid) DO UPDATE
       SET pairing_code = EXCLUDED.pairing_code,
           pairing_expires_at = EXCLUDED.pairing_expires_at,
           app_version = COALESCE(EXCLUDED.app_version, devices.app_version)
       RETURNING id, hardware_uid, pairing_code, pairing_expires_at, status`,
      [hardware_uid, device_category, pairingCode, app_version || '1.0.0']
    );

    return reply.status(201).send(res.rows[0]);
  });

  /**
   * 2. APROVAÇÃO DE HARDWARE (Exclusivo GLOBAL_ADMIN e IT_OPS)
   * Associa o código de 6 dígitos à Loja, Zona, Categoria e ScreenProfile, gerando o Device Token assinado.
   */
  app.post(
    '/api/v1/devices/pairing/approve',
    { preHandler: [requireRoles(['GLOBAL_ADMIN', 'IT_OPS'])] },
    async (request, reply) => {
      const schema = z.object({
        pairing_code: z.string().min(4),
        name: z.string().min(2),
        store_id: z.string().uuid(),
        store_zone_id: z.string().uuid(),
        screen_profile_id: z.string().uuid(),
        sync_group_id: z.string().uuid().nullable().optional(),
        device_category: z.enum([
          'ANDROID_BOX',
          'LEDWALL',
          'TV_DEMO',
          'LAPTOP_EXPO',
          'TABLET_EXPO',
          'SMARTPHONE_EXPO',
        ]),
        interaction_mode: z
          .enum(['PASSIVE', 'IDLE_SCREENSAVER', 'INTERACTIVE_CATALOG'])
          .default('PASSIVE'),
        idle_timeout_sec: z.number().int().min(10).max(600).default(45),
      });

      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      }

      const data = parsed.data;
      const rawDeviceToken = `dvt_${crypto.randomBytes(32).toString('hex')}`;
      const tokenHash = crypto.createHash('sha256').update(rawDeviceToken).digest('hex');

      const res = await db.query(
        `UPDATE devices
         SET name = $2,
             store_id = $3,
             store_zone_id = $4,
             screen_profile_id = $5,
             sync_group_id = $6,
             device_category = $7,
             interaction_mode = $8,
             idle_timeout_sec = $9,
             device_token_hash = $10,
             pairing_code = NULL,
             pairing_expires_at = NULL,
             status = 'ONLINE',
             last_seen_at = NOW()
         WHERE pairing_code = $1
         RETURNING id, name, store_id, store_zone_id, device_category, interaction_mode, status`,
        [
          data.pairing_code,
          data.name,
          data.store_id,
          data.store_zone_id,
          data.screen_profile_id,
          data.sync_group_id || null,
          data.device_category,
          data.interaction_mode,
          data.idle_timeout_sec,
          tokenHash,
        ]
      );

      if (res.rowCount === 0) {
        return reply.status(404).send({
          error: 'PAIRING_CODE_NOT_FOUND',
          message: 'Código de emparelhamento inválido ou já utilizado.',
        });
      }

      return {
        device: res.rows[0],
        device_token: rawDeviceToken, // Entregue uma única vez ao dispositivo/provisionador
      };
    }
  );

  /**
   * 3. MANIFEST PULL (Com suporte a ETag / 304 Not Modified e Staggered Rollout Jitter)
   */
  app.get('/api/v1/device/manifest', async (request, reply) => {
    const dev = await authenticateDevice(request, reply);
    if (!dev) return;

    const manifest = await buildDeviceManifest(dev.id);
    const clientEtag = request.headers['if-none-match'];

    if (clientEtag && clientEtag.replace(/"/g, '') === manifest.manifest_hash) {
      return reply.status(304).send();
    }

    reply.header('ETag', `"${manifest.manifest_hash}"`);
    return manifest;
  });

  /**
   * 4. HEARTBEAT (60s) + RECEÇÃO DE COMANDOS REMOTOS
   */
  app.post('/api/v1/device/heartbeat', async (request, reply) => {
    const dev = await authenticateDevice(request, reply);
    if (!dev) return;

    const schema = z.object({
      storage_free_bytes: z.number().nonnegative().default(0),
      current_manifest_hash: z.string().optional(),
      app_version: z.string().optional(),
    });

    const parsed = schema.safeParse(request.body || {});
    const body = parsed.success ? parsed.data : { storage_free_bytes: 0 };

    const pendingCommands = await recordDeviceHeartbeat({
      device_id: dev.id,
      storage_free_bytes: body.storage_free_bytes,
      current_manifest_hash: body.current_manifest_hash,
      app_version: body.app_version,
    });

    return {
      status: 'OK',
      server_time_ms: Date.now(),
      next_heartbeat_sec: Number(process.env.HEARTBEAT_INTERVAL_SEC || 60),
      commands: pendingCommands,
    };
  });

  /**
   * 5. COMANDOS REMOTOS DE HARDWARE (Exclusivo GLOBAL_ADMIN e IT_OPS)
   */
  app.post(
    '/api/v1/devices/:id/commands',
    { preHandler: [requireRoles(['GLOBAL_ADMIN', 'IT_OPS'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        command_type: z.enum(['REBOOT', 'CLEAR_CACHE', 'FORCE_SYNC', 'KILL_SWITCH', 'SET_ORIENTATION']),
        payload: z.record(z.any()).default({}),
      });

      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      }

      const res = await db.query(
        `INSERT INTO device_commands (device_id, issued_by, command_type, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING id, device_id, command_type, status, created_at`,
        [id, request.user.id, parsed.data.command_type, JSON.stringify(parsed.data.payload)]
      );

      return reply.status(201).send(res.rows[0]);
    }
  );

  /**
   * 6. LISTAGEM DE PARQUE DE DISPOSITIVOS (Respeitando RBAC de Loja/Departamento e supressão de alerta noturno)
   */
  app.get(
    '/api/v1/devices',
    {
      preHandler: [
        requireRoles(['GLOBAL_ADMIN', 'IT_OPS', 'MEDIA_MANAGER', 'STORE_MANAGER', 'DEPT_HEAD']),
      ],
    },
    async (request) => {
      const user = request.user;
      const storeScopeIds = user.scopes.map((s) => s.store_id).filter(Boolean);
      const zoneScopeIds = user.scopes.map((s) => s.store_zone_id).filter(Boolean);

      let whereClause = 'WHERE 1=1';
      const params: any[] = [];

      if (user.role === 'STORE_MANAGER' && storeScopeIds.length > 0) {
        params.push(storeScopeIds);
        whereClause += ` AND d.store_id = ANY($${params.length})`;
      } else if (user.role === 'DEPT_HEAD' && zoneScopeIds.length > 0) {
        params.push(zoneScopeIds);
        whereClause += ` AND d.store_zone_id = ANY($${params.length})`;
      }

      const res = await db.query(
        `SELECT d.*, s.name AS store_name, s.store_code, s.opening_hours,
                sz.name AS zone_name, sp.name AS profile_name, sp.aspect_ratio
         FROM devices d
         LEFT JOIN stores s ON s.id = d.store_id
         LEFT JOIN store_zones sz ON sz.id = d.store_zone_id
         LEFT JOIN screen_profiles sp ON sp.id = d.screen_profile_id
         ${whereClause}
         ORDER BY s.store_code ASC NULLS LAST, d.name ASC`,
        params
      );

      return res.rows.map((row) => {
        const isExpo = ['LAPTOP_EXPO', 'TABLET_EXPO', 'SMARTPHONE_EXPO', 'TV_DEMO'].includes(
          row.device_category
        );
        const storeOpen = row.opening_hours ? isStoreCurrentlyOpen(row.opening_hours) : true;
        return {
          ...row,
          alert_suppressed_after_hours: row.status === 'OFFLINE' && isExpo && !storeOpen,
        };
      });
    }
  );

  /**
   * 7. REPORTE DE INCIDENTES PELA LOJA (Diretor de Loja / Chefe de Departamento / Admin / IT)
   */
  app.post(
    '/api/v1/devices/:id/incidents',
    {
      preHandler: [
        requireRoles(['GLOBAL_ADMIN', 'IT_OPS', 'MEDIA_MANAGER', 'STORE_MANAGER', 'DEPT_HEAD']),
      ],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        incident_type: z.enum([
          'SCREEN_OFF',
          'WRONG_CONTENT',
          'OUTDATED_PRICE',
          'SYNC_DRIFT',
          'HARDWARE_DAMAGE',
        ]),
        description: z.string().min(5),
      });

      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      }

      const res = await db.query(
        `INSERT INTO device_incidents (device_id, reported_by, incident_type, description)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, request.user.id, parsed.data.incident_type, parsed.data.description]
      );

      return reply.status(201).send(res.rows[0]);
    }
  );
}

