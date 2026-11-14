import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../config/database.js';
import { authenticateDevice, requireRoles } from '../middleware/rbac.js';

export async function telemetryRoutes(app: FastifyInstance) {
  /**
   * 1. INGESTÃO EM LOTE (BATCH UPSERT) DE PROOF OF PLAY HORÁRIO (4.000 Dispositivos)
   * Idempotente: Se o Player reenviar o mesmo bloco horário após falha de rede, atualiza sem duplicar.
   */
  app.post('/api/v1/telemetry/pop/batch', async (request, reply) => {
    const dev = await authenticateDevice(request, reply);
    if (!dev) return;

    const schema = z.object({
      records: z
        .array(
          z.object({
            hour_bucket: z.string().datetime(),
            playlist_id: z.string().uuid(),
            campaign_id: z.string().uuid().nullable().optional(),
            media_asset_id: z.string().uuid(),
            play_count: z.number().int().positive(),
            total_duration_ms: z.number().int().nonnegative(),
          })
        )
        .min(1)
        .max(500),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_POP_BATCH', details: parsed.error.flatten() });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const rec of parsed.data.records) {
        await client.query(
          `INSERT INTO pop_logs_hourly (
            hour_bucket, device_id, store_id, brand_id, campaign_id,
            playlist_id, media_asset_id, play_count, total_duration_ms, updated_at
          ) VALUES (
            date_trunc('hour', $1::timestamptz), $2, $3, $4, $5, $6, $7, $8, $9, NOW()
          )
          ON CONFLICT (hour_bucket, device_id, playlist_id, media_asset_id)
          DO UPDATE SET
            play_count = GREATEST(pop_logs_hourly.play_count, EXCLUDED.play_count),
            total_duration_ms = GREATEST(pop_logs_hourly.total_duration_ms, EXCLUDED.total_duration_ms),
            updated_at = NOW()`,
          [
            rec.hour_bucket,
            dev.id,
            dev.store_id,
            dev.brand_id,
            rec.campaign_id || null,
            rec.playlist_id,
            rec.media_asset_id,
            rec.play_count,
            rec.total_duration_ms,
          ]
        );
      }
      await client.query('COMMIT');
      return { status: 'SYNCED', synced_records: parsed.data.records.length };
    } catch (err: any) {
      await client.query('ROLLBACK');
      return reply.status(500).send({ error: 'POP_SYNC_FAILED', message: err.message });
    } finally {
      client.release();
    }
  });

  /**
   * 2. INGESTÃO EM LOTE DE INTERAÇÕES (TOUCH EM PORTÁTEIS/SMARTPHONES/TABLETS & CATEGORIAS TV DEMO)
   */
  app.post('/api/v1/telemetry/interactions/batch', async (request, reply) => {
    const dev = await authenticateDevice(request, reply);
    if (!dev) return;

    const schema = z.object({
      records: z
        .array(
          z.object({
            hour_bucket: z.string().datetime(),
            interaction_type: z.enum(['TOUCH_WAKE', 'TV_CATEGORY_SELECT', 'TV_VIDEO_PLAY']),
            reference_key: z.string().default('GLOBAL'),
            interaction_count: z.number().int().positive(),
            total_engaged_seconds: z.number().int().nonnegative(),
          })
        )
        .min(1)
        .max(500),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: 'INVALID_INTERACTION_BATCH', details: parsed.error.flatten() });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const rec of parsed.data.records) {
        await client.query(
          `INSERT INTO interaction_logs_hourly (
            hour_bucket, device_id, store_id, brand_id, device_category,
            interaction_type, reference_key, interaction_count, total_engaged_seconds, updated_at
          ) VALUES (
            date_trunc('hour', $1::timestamptz), $2, $3, $4, $5, $6, $7, $8, $9, NOW()
          )
          ON CONFLICT (hour_bucket, device_id, interaction_type, reference_key)
          DO UPDATE SET
            interaction_count = GREATEST(interaction_logs_hourly.interaction_count, EXCLUDED.interaction_count),
            total_engaged_seconds = GREATEST(interaction_logs_hourly.total_engaged_seconds, EXCLUDED.total_engaged_seconds),
            updated_at = NOW()`,
          [
            rec.hour_bucket,
            dev.id,
            dev.store_id,
            dev.brand_id,
            dev.device_category,
            rec.interaction_type,
            rec.reference_key,
            rec.interaction_count,
            rec.total_engaged_seconds,
          ]
        );
      }
      await client.query('COMMIT');
      return { status: 'SYNCED', synced_records: parsed.data.records.length };
    } catch (err: any) {
      await client.query('ROLLBACK');
      return reply.status(500).send({ error: 'INTERACTION_SYNC_FAILED', message: err.message });
    } finally {
      client.release();
    }
  });

  /**
   * 3. RELATÓRIO DE AUDITORIA PROOF OF PLAY & INTERAÇÕES (Para Fornecedores / Gestão Multimédia)
   */
  app.get(
    '/api/v1/telemetry/reports/summary',
    {
      preHandler: [
        requireRoles(['GLOBAL_ADMIN', 'IT_OPS', 'MEDIA_MANAGER', 'STORE_MANAGER', 'DEPT_HEAD']),
      ],
    },
    async (request) => {
      const { brand_id, store_id, days = '7' } = request.query as Record<string, string>;
      const lookbackDays = Math.min(365, Math.max(1, parseInt(days, 10) || 7));

      const popRes = await db.query(
        `SELECT m.title AS media_title, p.name AS playlist_name,
                SUM(l.play_count)::BIGINT AS total_plays,
                ROUND(SUM(l.total_duration_ms) / 3600000.0, 2) AS total_hours_played
         FROM pop_logs_hourly l
         JOIN media_assets m ON m.id = l.media_asset_id
         JOIN playlists p ON p.id = l.playlist_id
         WHERE l.hour_bucket >= NOW() - ($1 || ' days')::INTERVAL
           AND ($2::uuid IS NULL OR l.brand_id = $2::uuid)
           AND ($3::uuid IS NULL OR l.store_id = $3::uuid)
         GROUP BY m.title, p.name
         ORDER BY total_plays DESC
         LIMIT 50`,
        [lookbackDays, brand_id || null, store_id || null]
      );

      const intRes = await db.query(
        `SELECT device_category, interaction_type,
                SUM(interaction_count)::BIGINT AS total_interactions,
                SUM(total_engaged_seconds)::BIGINT AS total_engaged_seconds
         FROM interaction_logs_hourly
         WHERE hour_bucket >= NOW() - ($1 || ' days')::INTERVAL
           AND ($2::uuid IS NULL OR brand_id = $2::uuid)
           AND ($3::uuid IS NULL OR store_id = $3::uuid)
         GROUP BY device_category, interaction_type
         ORDER BY total_interactions DESC`,
        [lookbackDays, brand_id || null, store_id || null]
      );

      return {
        period_days: lookbackDays,
        proof_of_play: popRes.rows,
        interactive_engagement: intRes.rows,
      };
    }
  );
}

