import type { Hono } from 'hono';
import { buildAgentEventRecord, isAgentEventType, type AgentEventIngestRequest } from '../agent/events';
import { getSupportedMarketChains } from '../config/appConfig';
import { buildRecommendationAssetLookup } from '../durableObjects/userAgentContentHelpers';
import {
  chatWithUserAgent,
  enqueueUserAgentJob,
  getUserAgentArticleDetail,
  getUserTodayDaily,
  ingestUserAgentEvent,
  listUserAgentArticles,
  listUserAgentRecommendations,
  regenerateUserTodayDaily,
  runUserAgentJobsNow,
  syncUserAgentPreferredLocale,
  syncUserAgentRequestLocale,
} from '../services/agent';
import { generateWithLlm, getLlmDebugStatus, getLlmErrorInfo, getLlmStatus } from '../services/llm';
import { fetchTopMarketAssets } from '../services/marketTopAssets';
import { generateTopicSpecialBatch } from '../services/topicSpecials';
import type { AppEnv } from '../types';
import { safeJsonParse } from '../utils/json';

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
    const shouldBackfillMetadata = doRecommendations.some((row) => {
      const symbol = (row.asset_symbol ?? row.asset_name ?? '').trim();
      return Boolean(symbol) && (!row.asset_chain || row.asset_contract == null);
    });
    let recommendationLookup = buildRecommendationAssetLookup([]);
    if (shouldBackfillMetadata) {
      const supportedChains = getSupportedMarketChains();
      const [marketCapResult, trendingResult] = await Promise.allSettled([
        fetchTopMarketAssets(c.env, {
          name: 'marketCap',
          limit: 80,
          source: 'auto',
          chains: supportedChains,
        }),
        fetchTopMarketAssets(c.env, {
          name: 'trending',
          limit: 40,
          source: 'auto',
          chains: supportedChains,
        }),
      ]);
      recommendationLookup = buildRecommendationAssetLookup([
        ...(marketCapResult.status === 'fulfilled' ? marketCapResult.value : []),
        ...(trendingResult.status === 'fulfilled' ? trendingResult.value : []),
      ]);
    }
    return c.json({
      recommendations: doRecommendations.map((row) => {
        const symbol = (row.asset_symbol ?? row.asset_name ?? '').trim().toUpperCase();
        const snapshot = recommendationLookup.get(symbol);
        return {
          id: row.id,
          kind: row.category,
          title: row.asset_name,
          content: row.reason,
          asset: {
            symbol: row.asset_symbol ?? row.asset_name,
            chain: row.asset_chain ?? snapshot?.chain ?? null,
            contract: row.asset_contract ?? snapshot?.contract ?? null,
            name: row.asset_display_name ?? snapshot?.name ?? row.asset_name,
            image: row.asset_image ?? snapshot?.image ?? null,
            price_change_percentage_24h: row.asset_price_change_24h ?? snapshot?.priceChange24h ?? null,
          },
          score: row.score,
          created_at: row.generated_at,
          valid_until: row.valid_until,
          source: 'do',
        };
      }),
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

  app.post('/v1/agent/chat', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    let body: {
      sessionId?: string;
      page?: string;
      pageContext?: Record<string, string>;
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    } | null = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }

    if (!body || !body.sessionId || !body.page || !Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ error: 'invalid_chat_request' }, 400);
    }

    try {
      const result = await chatWithUserAgent(c.env, userId, {
        sessionId: body.sessionId,
        page: body.page,
        pageContext: isRecord(body.pageContext) ? (body.pageContext as Record<string, string>) : {},
        messages: body.messages,
      });
      return c.json(result);
    } catch (error) {
      return c.json(
        {
          error: 'agent_chat_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/agent/llm/status', async (c) => {
    return c.json(getLlmStatus(c.env));
  });

  app.post('/v1/admin/llm/ping', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const llm = await getLlmDebugStatus(c.env);
    if (!llm.enabled) {
      return c.json({ ok: false, llm, error: { message: 'llm_api_key_not_configured' } }, 503);
    }

    try {
      const result = await generateWithLlm(c.env, {
        messages: [
          {
            role: 'system',
            content: 'Reply with exactly "ok".',
          },
          {
            role: 'user',
            content: 'ok',
          },
        ],
        temperature: 0,
        maxTokens: 8,
        retryAttempts: 1,
      });
      return c.json({
        ok: true,
        llm,
        result: {
          provider: result.provider,
          model: result.model,
          text: result.text,
          keyFingerprint: result.keyFingerprint ?? llm.keyFingerprint,
          requestId: result.requestId ?? null,
          cfRay: result.cfRay ?? null,
          server: result.server ?? null,
          openaiProject: result.openaiProject ?? null,
          openaiOrganization: result.openaiOrganization ?? null,
          rateLimitLimitRequests: result.rateLimitLimitRequests ?? null,
          rateLimitLimitTokens: result.rateLimitLimitTokens ?? null,
          rateLimitRemainingRequests: result.rateLimitRemainingRequests ?? null,
          rateLimitRemainingTokens: result.rateLimitRemainingTokens ?? null,
          rateLimitResetRequests: result.rateLimitResetRequests ?? null,
          rateLimitResetTokens: result.rateLimitResetTokens ?? null,
        },
      });
    } catch (error) {
      const llmError = getLlmErrorInfo(error);
      const status = llmError.status && llmError.status >= 400 && llmError.status < 600 ? llmError.status : 502;
      return new Response(
        JSON.stringify({
          ok: false,
          llm,
          error: {
            ...llmError,
            keyFingerprint: llmError.keyFingerprint ?? llm.keyFingerprint,
          },
        }),
        {
          status,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        },
      );
    }
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

  app.post('/v1/agent/jobs/daily-digest/regenerate', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    const result = await regenerateUserTodayDaily(c.env, userId);
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

}
