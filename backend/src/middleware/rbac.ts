import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { db } from '../config/database.js';

export type UserRole =
  | 'GLOBAL_ADMIN'
  | 'IT_OPS'
  | 'MEDIA_MANAGER'
  | 'STORE_MANAGER'
  | 'DEPT_HEAD';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  scopes: Array<{
    brand_id: string | null;
    store_id: string | null;
    store_zone_id: string | null;
  }>;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthenticatedUser;
    user: AuthenticatedUser;
  }
}

/**
 * Hash de password seguro usando Node native scrypt (compatível com Alpine sem compilação C++)
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  return crypto.timingSafeEqual(derived, keyBuffer);
}

/**
 * Middleware: Exige utilizador autenticado e valida se o Role pertence aos perfis autorizados
 */
export function requireRoles(allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      if (!allowedRoles.includes(request.user.role)) {
        return reply.status(403).send({
          error: 'FORBIDDEN_GOVERNANCE_POLICY',
          message: `O perfil '${request.user.role}' não tem permissão para executar esta operação. Perfis exigidos: ${allowedRoles.join(', ')}.`,
        });
      }
    } catch {
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Sessão inválida ou expirada.',
      });
    }
  };
}

/**
 * Middleware: Autentica um dos ~4.000 Dispositivos através do cabeçalho X-Device-Token
 */
export async function authenticateDevice(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<{
  id: string;
  store_id: string;
  store_zone_id: string;
  brand_id: string;
  device_category: string;
  screen_profile_id: string;
} | null> {
  const rawToken = request.headers['x-device-token'];
  if (!rawToken || typeof rawToken !== 'string') {
    reply.status(401).send({ error: 'MISSING_DEVICE_TOKEN' });
    return null;
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const res = await db.query(
    `SELECT d.id, d.store_id, d.store_zone_id, d.device_category, d.screen_profile_id, s.brand_id
     FROM devices d
     JOIN stores s ON s.id = d.store_id
     WHERE d.device_token_hash = $1 AND d.status != 'PENDING_APPROVAL'
     LIMIT 1`,
    [tokenHash]
  );

  if (res.rowCount === 0) {
    reply.status(401).send({ error: 'INVALID_OR_UNPAIRED_DEVICE_TOKEN' });
    return null;
  }

  return res.rows[0];
}

