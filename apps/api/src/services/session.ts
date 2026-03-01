import { nowIso } from '../utils/time';

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ id: string; expiresAt: string }> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, expiresAt, nowIso())
    .run();
  return { id, expiresAt };
}

export async function getSessionByToken(
  db: D1Database,
  token: string,
): Promise<{ userId: string; expiresAt: string } | null> {
  const session = await db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE id = ? LIMIT 1')
    .bind(token)
    .first<{ user_id: string; expires_at: string }>();

  if (!session) return null;

  return {
    userId: session.user_id,
    expiresAt: session.expires_at,
  };
}

export async function deleteSessionByToken(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
}
