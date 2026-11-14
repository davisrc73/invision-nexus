import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../config/database.js';
import { hashPassword, verifyPassword, requireRoles } from '../middleware/rbac.js';

export async function authRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/auth/login
   * Autenticação JWT para utilizadores do Dashboard (Global Admin, IT Ops, Media Manager, Store Manager, Dept Head)
   */
  app.post('/api/v1/auth/login', async (request, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const { email, password } = parsed.data;
    const userRes = await db.query(
      `SELECT id, email, password_hash, full_name, role, is_active
       FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );

    if (userRes.rowCount === 0) {
      return reply.status(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    const user = userRes.rows[0];
    if (!user.is_active || !verifyPassword(password, user.password_hash)) {
      return reply.status(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    const scopesRes = await db.query(
      `SELECT brand_id, store_id, store_zone_id FROM user_scopes WHERE user_id = $1`,
      [user.id]
    );

    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
      scopes: scopesRes.rows,
    };

    const token = app.jwt.sign(payload, { expiresIn: '12h' });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        scopes: scopesRes.rows,
      },
    };
  });

  /**
   * POST /api/v1/auth/users
   * Criação de utilizadores (Exclusivo GLOBAL_ADMIN)
   */
  app.post(
    '/api/v1/auth/users',
    { preHandler: [requireRoles(['GLOBAL_ADMIN'])] },
    async (request, reply) => {
      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(8),
        full_name: z.string().min(2),
        role: z.enum(['GLOBAL_ADMIN', 'IT_OPS', 'MEDIA_MANAGER', 'STORE_MANAGER', 'DEPT_HEAD']),
        scopes: z
          .array(
            z.object({
              brand_id: z.string().uuid().nullable().optional(),
              store_id: z.string().uuid().nullable().optional(),
              store_zone_id: z.string().uuid().nullable().optional(),
            })
          )
          .default([]),
      });

      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      }

      const data = parsed.data;
      const passwordHash = hashPassword(data.password);

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const insertUser = await client.query(
          `INSERT INTO users (email, password_hash, full_name, role)
           VALUES ($1, $2, $3, $4)
           RETURNING id, email, full_name, role, created_at`,
          [data.email, passwordHash, data.full_name, data.role]
        );

        const newUser = insertUser.rows[0];
        for (const sc of data.scopes) {
          await client.query(
            `INSERT INTO user_scopes (user_id, brand_id, store_id, store_zone_id)
             VALUES ($1, $2, $3, $4)`,
            [newUser.id, sc.brand_id || null, sc.store_id || null, sc.store_zone_id || null]
          );
        }

        await client.query('COMMIT');
        return reply.status(201).send(newUser);
      } catch (err: any) {
        await client.query('ROLLBACK');
        return reply.status(409).send({ error: 'USER_CREATION_FAILED', message: err.message });
      } finally {
        client.release();
      }
    }
  );
}

