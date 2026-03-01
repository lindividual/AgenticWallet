import { nowIso } from '../utils/time';

export async function saveChallenge(
  db: D1Database,
  input: { id: string; userId: string | null; challenge: string; ceremony: string },
): Promise<void> {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await db.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?').bind(now).run();
  await db
    .prepare(
      'INSERT INTO auth_challenges (id, user_id, ceremony, challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(input.id, input.userId, input.ceremony, input.challenge, expiresAt, now)
    .run();
}

export async function getChallenge(
  db: D1Database,
  challengeId: string,
  ceremony: string,
  userId: string | null,
): Promise<{ challenge: string } | null> {
  const row = await db
    .prepare(
      `SELECT challenge, expires_at FROM auth_challenges
       WHERE id = ? AND ceremony = ? AND (? IS NULL OR user_id = ?)
       LIMIT 1`,
    )
    .bind(challengeId, ceremony, userId, userId)
    .first<{ challenge: string; expires_at: string }>();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.prepare('DELETE FROM auth_challenges WHERE id = ?').bind(challengeId).run();
    return null;
  }

  return { challenge: row.challenge };
}
