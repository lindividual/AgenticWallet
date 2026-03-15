import type { Bindings } from '../types';
import { deleteArticleMarkdownContent } from '../durableObjects/userAgentArticleContentStore';

const TOPIC_SPECIAL_RETENTION_DAYS = 90;
const TOPIC_SPECIAL_DELETE_BATCH_SIZE = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type CountRow = {
  count: number | string | null;
};

type TopicSpecialArchiveRow = {
  id: string;
  r2_key: string;
};

function toFiniteCount(value: number | string | null | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function daysAgoIso(days: number, now = Date.now()): string {
  return new Date(now - days * MS_PER_DAY).toISOString();
}

export async function runD1Maintenance(env: Bindings): Promise<void> {
  const nowIso = new Date().toISOString();
  const topicSpecialCutoff = daysAgoIso(TOPIC_SPECIAL_RETENTION_DAYS);

  const [
    expiredChallengesRow,
    expiredSessionsRow,
    expiredPredictionEventsRow,
    expiredMarketShelfRow,
    topicSpecialRowsResult,
  ] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM auth_challenges WHERE expires_at <= ?')
      .bind(nowIso)
      .first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at <= ?')
      .bind(nowIso)
      .first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM prediction_events WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .bind(nowIso)
      .first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM market_shelf_cache WHERE expires_at <= ?')
      .bind(nowIso)
      .first<CountRow>(),
    env.DB.prepare(
      `SELECT id, r2_key
       FROM topic_special_articles
       WHERE generated_at < ?
       ORDER BY generated_at ASC
       LIMIT ?`,
    )
      .bind(topicSpecialCutoff, TOPIC_SPECIAL_DELETE_BATCH_SIZE)
      .all<TopicSpecialArchiveRow>(),
  ]);

  const expiredChallenges = toFiniteCount(expiredChallengesRow?.count);
  const expiredSessions = toFiniteCount(expiredSessionsRow?.count);
  const expiredPredictionEvents = toFiniteCount(expiredPredictionEventsRow?.count);
  const expiredMarketShelfRows = toFiniteCount(expiredMarketShelfRow?.count);
  const topicSpecialRows = topicSpecialRowsResult.results ?? [];

  const statements = [];
  if (expiredChallenges > 0) {
    statements.push(env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?').bind(nowIso));
  }
  if (expiredSessions > 0) {
    statements.push(env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowIso));
  }
  if (expiredPredictionEvents > 0) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM prediction_outcomes
         WHERE prediction_event_id IN (
           SELECT prediction_event_id
           FROM prediction_events
           WHERE expires_at IS NOT NULL AND expires_at <= ?
         )`,
      ).bind(nowIso),
    );
    statements.push(
      env.DB.prepare(
        `DELETE FROM prediction_markets
         WHERE prediction_event_id IN (
           SELECT prediction_event_id
           FROM prediction_events
           WHERE expires_at IS NOT NULL AND expires_at <= ?
         )`,
      ).bind(nowIso),
    );
    statements.push(
      env.DB.prepare('DELETE FROM prediction_events WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(nowIso),
    );
  }
  if (expiredMarketShelfRows > 0) {
    statements.push(env.DB.prepare('DELETE FROM market_shelf_cache WHERE expires_at <= ?').bind(nowIso));
  }
  if (topicSpecialRows.length > 0) {
    statements.push(
      ...topicSpecialRows.map((row) => env.DB.prepare('DELETE FROM topic_special_articles WHERE id = ?').bind(row.id)),
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  let topicSpecialR2DeleteFailures = 0;
  if (topicSpecialRows.length > 0) {
    const results = await Promise.allSettled(topicSpecialRows.map((row) => deleteArticleMarkdownContent(env, row.r2_key)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      topicSpecialR2DeleteFailures += 1;
      console.error('d1_maintenance_topic_special_r2_delete_failed', {
        articleId: topicSpecialRows[index]?.id ?? 'unknown',
        r2Key: topicSpecialRows[index]?.r2_key ?? 'unknown',
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });
  }

  console.log('d1_maintenance_completed', {
    expiredChallenges,
    expiredSessions,
    expiredPredictionEvents,
    expiredMarketShelfRows,
    archivedTopicSpecialArticles: topicSpecialRows.length,
    topicSpecialR2DeleteFailures,
    topicSpecialRetentionDays: TOPIC_SPECIAL_RETENTION_DAYS,
  });
}
