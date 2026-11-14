import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../config/database.js';
import { requireRoles } from '../middleware/rbac.js';
import {
  probeMediaFile,
  generateThumbnail,
  validateMediaAgainstProfile,
} from '../services/formatGuardrail.js';

const MEDIA_DIR = process.env.MEDIA_STORAGE_PATH || path.resolve('./data/storage/media');
const THUMBS_DIR = process.env.THUMBS_STORAGE_PATH || path.resolve('./data/storage/thumbs');

export async function mediaRoutes(app: FastifyInstance) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });

  /**
   * 1. UPLOAD DE MEDIA COM INSPECÇÃO FFPROBE & FORMAT GUARDRAIL (Exclusivo Equipa Multimédia & Admin Global)
   * Query/Headers esperados: brand_id, title, target_screen_profile_id (opcional no upload, obrigatório na playlist)
   */
  app.post(
    '/api/v1/media/upload',
    { preHandler: [requireRoles(['GLOBAL_ADMIN', 'MEDIA_MANAGER'])] },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'MISSING_FILE', message: 'Nenhum ficheiro enviado.' });
      }

      const fields = data.fields as Record<string, any>;
      const brandId = fields.brand_id?.value;
      const title = fields.title?.value || data.filename;
      const targetProfileId = fields.target_screen_profile_id?.value;
      const isFallbackEligible = fields.is_fallback_eligible?.value === 'true';

      if (!brandId) {
        return reply.status(400).send({
          error: 'MISSING_BRAND_ID',
          message: 'É obrigatório associar o conteúdo a uma Insígnia (Fnac ou Darty).',
        });
      }

      const safeExt = path.extname(data.filename) || '.mp4';
      const tempFileName = `${crypto.randomUUID()}${safeExt}`;
      const finalFilePath = path.join(MEDIA_DIR, tempFileName);

      await pipeline(data.file, fs.createWriteStream(finalFilePath));

      try {
        const meta = await probeMediaFile(finalFilePath);

        // Se foi indicado um Perfil de Ecrã alvo no upload, executa o Format Guardrail imediatamente
        if (targetProfileId) {
          const profRes = await db.query(`SELECT * FROM screen_profiles WHERE id = $1`, [
            targetProfileId,
          ]);
          if (profRes.rowCount && profRes.rowCount > 0) {
            const check = validateMediaAgainstProfile(meta, profRes.rows[0]);
            if (!check.valid) {
              fs.unlinkSync(finalFilePath);
              return reply.status(422).send({
                error: 'FORMAT_GUARDRAIL_REJECTED',
                message: check.reason,
                detected: {
                  width_px: meta.width_px,
                  height_px: meta.height_px,
                  aspect_ratio: meta.aspect_ratio,
                  codec: meta.codec_info,
                },
              });
            }
          }
        }

        // Gera 1 thumbnail estático (.webp) sem recodificar o vídeo
        const thumbName = `${path.parse(tempFileName).name}.webp`;
        const thumbFullPath = path.join(THUMBS_DIR, thumbName);
        try {
          await generateThumbnail(finalFilePath, thumbFullPath);
        } catch {
          // Se for imagem ou falhar frame grab no segundo 1, continua sem bloquear
        }

        const insertRes = await db.query(
          `INSERT INTO media_assets (
            brand_id, title, file_name, file_path, thumb_path, sha256_hash,
            file_size_bytes, mime_type, width_px, height_px, aspect_ratio,
            duration_ms, codec_info, is_fallback_eligible, uploaded_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING *`,
          [
            brandId,
            title,
            data.filename,
            finalFilePath,
            fs.existsSync(thumbFullPath) ? thumbFullPath : null,
            meta.sha256_hash,
            meta.file_size_bytes,
            data.mimetype,
            meta.width_px,
            meta.height_px,
            meta.aspect_ratio,
            meta.duration_ms,
            meta.codec_info,
            isFallbackEligible,
            request.user.id,
          ]
        );

        return reply.status(201).send(insertRes.rows[0]);
      } catch (err: any) {
        if (fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
        return reply.status(422).send({
          error: 'MEDIA_INSPECTION_FAILED',
          message: err.message,
        });
      }
    }
  );

  /**
   * 2. DOWNLOAD RESILIENTE COM HTTP RANGE REQUESTS (206 Partial Content)
   * Permite que os ~4.000 Players retomem downloads interrompidos para os 64GB ROM sem recomeçar do zero.
   */
  app.get('/api/v1/media/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    const res = await db.query(
      `SELECT file_path, file_size_bytes, mime_type, sha256_hash FROM media_assets WHERE id = $1`,
      [id]
    );

    if (res.rowCount === 0) {
      return reply.status(404).send({ error: 'MEDIA_NOT_FOUND' });
    }

    const media = res.rows[0];
    if (!fs.existsSync(media.file_path)) {
      return reply.status(404).send({ error: 'MEDIA_FILE_MISSING_ON_DISK' });
    }

    const totalSize = Number(media.file_size_bytes);
    const range = request.headers.range;

    reply.header('Accept-Ranges', 'bytes');
    reply.header('ETag', `"${media.sha256_hash}"`);
    reply.header('X-Content-SHA256', media.sha256_hash);
    reply.header('Content-Type', media.mime_type || 'video/mp4');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      if (start >= totalSize || end >= totalSize) {
        reply.header('Content-Range', `bytes */${totalSize}`);
        return reply.status(416).send();
      }

      const chunkSize = end - start + 1;
      reply.status(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      reply.header('Content-Length', chunkSize);
      return reply.send(fs.createReadStream(media.file_path, { start, end }));
    }

    reply.header('Content-Length', totalSize);
    return reply.send(fs.createReadStream(media.file_path));
  });

  /**
   * 3. CRIAÇÃO DE PLAYLIST (Com suporte Dual: FIXED_SLOTS ou DYNAMIC_SOV e Isolamento por Insígnia)
   */
  app.post(
    '/api/v1/playlists',
    { preHandler: [requireRoles(['GLOBAL_ADMIN', 'MEDIA_MANAGER'])] },
    async (request, reply) => {
      const schema = z.object({
        brand_id: z.string().uuid(),
        campaign_id: z.string().uuid().nullable().optional(),
        name: z.string().min(2),
        target_screen_profile_id: z.string().uuid(),
        priority_level: z.enum(['EXCLUSIVA', 'PRIORITARIA', 'NORMAL', 'FALLBACK']).default('NORMAL'),
        scheduling_mode: z.enum(['FIXED_SLOTS', 'DYNAMIC_SOV']).default('FIXED_SLOTS'),
        total_slots: z.number().int().positive().nullable().optional(),
      });

      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      }

      const d = parsed.data;
      const res = await db.query(
        `INSERT INTO playlists (
          brand_id, campaign_id, name, target_screen_profile_id,
          priority_level, scheduling_mode, total_slots, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [
          d.brand_id,
          d.campaign_id || null,
          d.name,
          d.target_screen_profile_id,
          d.priority_level,
          d.scheduling_mode,
          d.scheduling_mode === 'FIXED_SLOTS' ? d.total_slots || 10 : null,
          request.user.id,
        ]
      );

      return reply.status(201).send(res.rows[0]);
    }
  );

  /**
   * 4. ADICIONAR ITEM À PLAYLIST (Com verificação obrigatória do FORMAT GUARDRAIL + Isolamento de Insígnia)
   */
  app.post(
    '/api/v1/playlists/:id/items',
    { preHandler: [requireRoles(['GLOBAL_ADMIN', 'MEDIA_MANAGER'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        media_asset_id: z.string().uuid(),
        slot_position: z.number().int().positive().nullable().optional(),
        sov_percentage: z.number().min(0.01).max(100).nullable().optional(),
        custom_duration_ms: z.number().int().positive().nullable().optional(),
        scaling_policy: z.enum(['CONTAIN', 'COVER', 'STRETCH']).default('CONTAIN'),
        force_format_override: z.boolean().default(false),
      });

      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      }

      const body = parsed.data;

      // Carrega Playlist + ScreenProfile associado
      const plRes = await db.query(
        `SELECT p.*, sp.name AS profile_name, sp.width_px AS prof_w, sp.height_px AS prof_h,
                sp.aspect_ratio AS prof_ratio, sp.aspect_tolerance_pct, sp.allowed_codecs
         FROM playlists p
         JOIN screen_profiles sp ON sp.id = p.target_screen_profile_id
         WHERE p.id = $1`,
        [id]
      );

      if (plRes.rowCount === 0) {
        return reply.status(404).send({ error: 'PLAYLIST_NOT_FOUND' });
      }

      const playlist = plRes.rows[0];

      // Carrega Media Asset
      const mediaRes = await db.query(`SELECT * FROM media_assets WHERE id = $1`, [
        body.media_asset_id,
      ]);
      if (mediaRes.rowCount === 0) {
        return reply.status(404).send({ error: 'MEDIA_ASSET_NOT_FOUND' });
      }

      const media = mediaRes.rows[0];

      // GUARDRAIL 1: Isolamento Estrito de Insígnia (Fnac vs Darty)
      if (media.brand_id !== playlist.brand_id) {
        return reply.status(403).send({
          error: 'CROSS_BRAND_VIOLATION',
          message:
            'Violação de Governance: Não é permitido associar um conteúdo de uma Insígnia (Fnac/Darty) a uma Playlist de outra Insígnia.',
        });
      }

      // GUARDRAIL 2: Format Guardrail (Resolução & Aspect Ratio do Vídeo vs Terminal)
      const formatCheck = validateMediaAgainstProfile(media, {
        name: playlist.profile_name,
        width_px: playlist.prof_w,
        height_px: playlist.prof_h,
        aspect_ratio: playlist.prof_ratio,
        aspect_tolerance_pct: playlist.aspect_tolerance_pct,
        allowed_codecs: playlist.allowed_codecs,
      });

      if (!formatCheck.valid && !body.force_format_override) {
        return reply.status(422).send({
          error: 'FORMAT_GUARDRAIL_BLOCKED',
          message: formatCheck.reason,
          hint: 'Exporte o vídeo na resolução nativa do terminal ou, se for GLOBAL_ADMIN, autorize explicitamente force_format_override com scaling_policy.',
        });
      }

      const insertRes = await db.query(
        `INSERT INTO playlist_items (
          playlist_id, media_asset_id, slot_position, sov_percentage,
          custom_duration_ms, scaling_policy, force_format_override
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *`,
        [
          id,
          body.media_asset_id,
          body.slot_position || null,
          body.sov_percentage || null,
          body.custom_duration_ms || null,
          body.scaling_policy,
          body.force_format_override,
        ]
      );

      return reply.status(201).send(insertRes.rows[0]);
    }
  );
}

