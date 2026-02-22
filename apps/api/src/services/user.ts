import type { UserSummary } from '../types';

export async function getUserSummary(db: D1Database, userId: string): Promise<UserSummary> {
  const user = await db
    .prepare('SELECT id, handle, display_name FROM users WHERE id = ? LIMIT 1')
    .bind(userId)
    .first<{ id: string; handle: string; display_name: string }>();

  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  return {
    id: user.id,
    handle: user.handle,
    displayName: user.display_name,
  };
}
