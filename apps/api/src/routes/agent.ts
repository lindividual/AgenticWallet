import type { Hono } from 'hono';
import { buildAgentEventRecord, isAgentEventType, type AgentEventIngestRequest } from '../agent/events';
import {
  enqueueUserAgentJob,
  getUserAgentArticleDetail,
  getUserTodayDaily,
  ingestUserAgentEvent,
  listUserAgentArticles,
  listUserAgentRecommendations,
  runUserAgentJobsNow,
  syncUserAgentPreferredLocale,
  syncUserAgentRequestLocale,
} from '../services/agent';
import { getLlmStatus } from '../services/llm';
import { generateTopicSpecialBatch } from '../services/topicSpecials';
import type { AppEnv } from '../types';
import { safeJsonParse } from '../utils/json';
import { nowIso } from '../utils/time';

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function normalizePreferredLocale(raw: string | undefined): string | null {
  if (!raw) return null;
  const first = raw
    .split(',')
    .map((item) => item.split(';')[0] ?? item)
    .map((item) => item.trim())
    .filter(Boolean)[0];
  if (!first) return null;
  return first.toLowerCase();
}

function hasTopicSpecialAdminAccess(c: {
  env: AppEnv['Bindings'];
  req: { header: (name: string) => string | undefined };
}): boolean {
  const expected = c.env.TOPIC_SPECIAL_ADMIN_TOKEN?.trim();
  if (!expected) return false;
  const provided = (c.req.header('x-topic-special-admin-token') ?? '').trim();
  return provided.length > 0 && provided === expected;
}

function toApiArticle(row: {
  id: string;
  article_type: string;
  title: string;
  summary: string;
  r2_key: string;
  tags_json: string;
  created_at: string;
  status: string;
}) {
  return {
    id: row.id,
    type: row.article_type,
    title: row.title,
    summary: row.summary,
    mdKey: row.r2_key,
    tags: safeJsonParse<string[]>(row.tags_json) ?? [],
    created_at: row.created_at,
    status: row.status,
  };
}

export function registerAgentRoutes(app: Hono<AppEnv>): void {
  app.post('/v1/agent/events', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    let body: AgentEventIngestRequest | null = null;
    try {
      body = await c.req.json<AgentEventIngestRequest>();
    } catch {
      body = null;
    }

    if (!body || !isAgentEventType(body.type)) {
      return c.json({ error: 'invalid_event_type' }, 400);
    }

    if (body.payload !== undefined && !isRecord(body.payload)) {
      return c.json({ error: 'invalid_payload' }, 400);
    }

    const event = buildAgentEventRecord(userId, body);

    try {
      const result = await ingestUserAgentEvent(c.env, userId, event);
      return c.json(result);
    } catch (error) {
      return c.json(
        {
          error: 'agent_event_ingest_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/agent/recommendations', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    const doRecommendations = await listUserAgentRecommendations(c.env, userId, 10);
    return c.json({
      recommendations: doRecommendations.map((row) => ({
        id: row.id,
        kind: row.category,
        title: row.asset_name,
        content: row.reason,
        asset: {
          symbol: row.asset_symbol ?? row.asset_name,
          chain: row.asset_chain,
          contract: row.asset_contract,
          name: row.asset_display_name ?? row.asset_name,
          image: row.asset_image,
          price_change_percentage_24h: row.asset_price_change_24h,
        },
        score: row.score,
        created_at: row.generated_at,
        valid_until: row.valid_until,
        source: 'do',
      })),
    });
  });

  app.get('/v1/agent/articles', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    const articleType = c.req.query('type') ?? undefined;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Number(limitRaw) : 20;
    const articles = await listUserAgentArticles(c.env, userId, {
      articleType,
      limit: Number.isFinite(limit) ? limit : 20,
    });

    return c.json({
      articles: articles.map((row) => toApiArticle(row)),
    });
  });

  app.get('/v1/agent/daily/today', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    const daily = await getUserTodayDaily(c.env, userId);
    if (!daily) {
      return c.json({ error: 'daily_unavailable' }, 503);
    }

    return c.json({
      date: daily.date,
      status: daily.status,
      article: daily.article ? toApiArticle(daily.article) : null,
      lastReadyArticle: daily.lastReadyArticle ? toApiArticle(daily.lastReadyArticle) : null,
    });
  });

  app.get('/v1/agent/articles/:articleId', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    const articleId = c.req.param('articleId');
    const detail = await getUserAgentArticleDetail(c.env, userId, articleId);
    if (!detail) {
      return c.json({ error: 'article_not_found' }, 404);
    }
    return c.json({
      article: {
        ...toApiArticle(detail.article),
      },
      markdown: detail.markdown,
    });
  });

  app.post('/v1/agent/preferences/locale', async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json<{ locale?: string }>().catch(() => ({ locale: undefined }));
    const locale = typeof body.locale === 'string' ? body.locale.trim().toLowerCase().slice(0, 32) : '';
    await syncUserAgentPreferredLocale(c.env, userId, locale || null);
    return c.json({ ok: true });
  });

  app.get('/v1/agent/llm/status', async (c) => {
    return c.json(getLlmStatus(c.env));
  });

  app.post('/v1/agent/jobs/daily-digest/run', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    const today = new Date().toISOString().slice(0, 10);
    const result = await enqueueUserAgentJob(c.env, userId, {
      jobType: 'daily_digest',
      runAt: new Date().toISOString(),
      jobKey: `manual_daily_digest:${today}`,
      payload: { trigger: 'manual' },
    });
    await runUserAgentJobsNow(c.env, userId);
    return c.json(result);
  });

  app.post('/v1/agent/jobs/recommendations/run', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    const today = new Date().toISOString().slice(0, 10);
    const result = await enqueueUserAgentJob(c.env, userId, {
      jobType: 'recommendation_refresh',
      runAt: new Date().toISOString(),
      jobKey: `manual_recommendation_refresh:${today}`,
      payload: { trigger: 'manual' },
    });
    await runUserAgentJobsNow(c.env, userId);
    return c.json(result);
  });

  app.post('/v1/agent/jobs/topic/run', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    const body = await c.req.json<{ topic?: string }>().catch(
      () =>
        ({
          topic: undefined,
        }) satisfies { topic?: string },
    );
    const normalizedTopic = typeof body.topic === 'string' ? body.topic.trim() : '';
    const result = await enqueueUserAgentJob(c.env, userId, {
      jobType: 'topic_generation',
      runAt: new Date().toISOString(),
      jobKey: `manual_topic_generation:${new Date().toISOString().slice(0, 16)}:${normalizedTopic || 'default'}`,
      payload: normalizedTopic ? { topic: normalizedTopic } : { trigger: 'manual' },
    });
    await runUserAgentJobsNow(c.env, userId);
    return c.json(result);
  });

  app.post('/v1/admin/topic-specials/run', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json<{ force?: boolean }>().catch(
      () =>
        ({
          force: undefined,
        }) satisfies { force?: boolean },
    );
    const result = await generateTopicSpecialBatch(c.env, {
      force: body.force === true,
    });
    return c.json({
      ok: true,
      jobId: `topic_special:${result.slotKey}`,
      deduped: result.skipped,
      slotKey: result.slotKey,
      generated: result.generated,
      totalInSlot: result.totalInSlot,
    });
  });

  app.post('/v1/agent/recommendations/mock', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    await c.env.DB.prepare(
      'INSERT INTO recommendations (id, user_id, kind, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        crypto.randomUUID(),
        userId,
        'code',
        'Transfer Script Suggestion',
        'Use viem walletClient.writeContract to execute an ERC20 transfer and add simulation before submit.',
        nowIso(),
      )
      .run();

    return c.json({ ok: true });
  });
}
