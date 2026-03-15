import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { getSessionByToken } from '../services/session';

function readBearerToken(value: string | undefined): string | null {
  if (!value || !value.startsWith('Bearer ')) {
    return null;
  }

  const token = value.slice('Bearer '.length).trim();
  return token || null;
}

function resolveAdminApiToken(env: AppEnv['Bindings']): string | null {
  return env.ADMIN_API_TOKEN?.trim() || env.TOPIC_SPECIAL_ADMIN_TOKEN?.trim() || null;
}

function readAdminToken(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  return (
    readBearerToken(c.req.header('authorization')) ??
    c.req.header('x-admin-token')?.trim() ??
    c.req.header('x-topic-special-admin-token')?.trim() ??
    null
  );
}

export function isAdminApiPath(path: string): boolean {
  return path === '/v1/admin' || path.startsWith('/v1/admin/');
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readBearerToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'missing_bearer_token' }, 401);
  }

  const session = await getSessionByToken(c.env.DB, token);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    return c.json({ error: 'session_expired' }, 401);
  }

  c.set('userId', session.userId);
  c.set('sessionToken', token);
  await next();
};

export const requireAdminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expectedToken = resolveAdminApiToken(c.env);
  if (!expectedToken) {
    return c.json({ error: 'admin_token_not_configured' }, 503);
  }

  const providedToken = readAdminToken(c);
  if (!providedToken) {
    return c.json({ error: 'missing_admin_token' }, 401);
  }

  if (providedToken !== expectedToken) {
    return c.json({ error: 'invalid_admin_token' }, 403);
  }

  await next();
};
