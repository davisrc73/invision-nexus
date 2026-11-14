import pg from 'pg';
import { Redis } from 'ioredis';

const { Pool } = pg;

export const db = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://invision_admin:invision_secret_2026@localhost:5432/invision_nexus',
  max: 25,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

