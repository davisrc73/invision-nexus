import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { db } from './config/database.js';
import { hashPassword } from './middleware/rbac.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { mediaRoutes } from './routes/media.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { evaluateOfflineDevices } from './services/heartbeatMonitor.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
  bodyLimit: 524288000, // 500MB max upload para vídeos 4K UHD
});

async function bootstrap() {
  await app.register(cors, {
    origin: true,
    exposedHeaders: ['ETag', 'Content-Range', 'Accept-Ranges', 'X-Content-SHA256'],
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET || 'fnac_darty_invision_super_secret_jwt_key_change_in_prod',
  });

  await app.register(multipart, {
    limits: {
      fileSize: 524288000, // 500MB
    },
  });

  await app.register(websocket);

  // Healthcheck Endpoint
  app.get('/api/v1/health', async () => {
    const dbCheck = await db.query('SELECT NOW() as db_time');
    return {
      status: 'HEALTHY',
      service: 'invision-nexus-backend',
      server_time_ms: Date.now(),
      db_time: dbCheck.rows[0].db_time,
    };
  });

  // WebSocket Time & Sync Channel (Preparação para Fase 5 - Frame Sync ao milissegundo)
  app.get('/ws/sync', { websocket: true }, (socket) => {
    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'NTP_PING') {
          socket.send(
            JSON.stringify({
              type: 'NTP_PONG',
              client_t0: msg.client_t0,
              server_t1: Date.now(),
              server_t2: Date.now(),
            })
          );
        }
      } catch {
        // Ignora pacotes malformados
      }
    });
  });

  // Regista os módulos de rotas REST
  await app.register(authRoutes);
  await app.register(deviceRoutes);
  await app.register(mediaRoutes);
  await app.register(telemetryRoutes);

  // Garante criação do Administrador Global inicial se a tabela users estiver vazia
  try {
    const countRes = await db.query('SELECT COUNT(*)::int AS total FROM users');
    if (countRes.rows[0].total === 0) {
      const defaultAdminHash = hashPassword('FnacDarty2026!');
      await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('admin@invision-nexus.internal', $1, 'Global Admin (Fnac & Darty)', 'GLOBAL_ADMIN')
         ON CONFLICT (email) DO NOTHING`,
        [defaultAdminHash]
      );
      app.log.info('Seeded default GLOBAL_ADMIN: admin@invision-nexus.internal');
    }
  } catch (err: any) {
    app.log.warn(`Database seed check skipped/deferred: ${err.message}`);
  }

  // Worker de Monitorização de Heartbeats (60 em 60 segundos) com supressão noturna para Expo
  setInterval(async () => {
    try {
      await evaluateOfflineDevices();
    } catch (err: any) {
      app.log.error(`Heartbeat evaluator error: ${err.message}`);
    }
  }, 60_000);

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  await app.listen({ port, host });
  app.log.info(`Invision Nexus Backend listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});

