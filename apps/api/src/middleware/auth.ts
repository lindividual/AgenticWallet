import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { getSessionByToken } from '../services/session';

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'missing_bearer_token' }, 401);
  }

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return c.json({ error: 'invalid_bearer_token' }, 401);
  }

  const session = await getSessionByToken(c.env.DB, token);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    return c.json({ error: 'session_expired' }, 401);
  }

  c.set('userId', session.userId);
  await next();
};
