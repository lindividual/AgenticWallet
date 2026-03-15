import type { Hono } from 'hono';
import { buildAgentEventRecord, isAgentEventType, type AgentEventIngestRequest } from '../agent/events';
import {
  chatWithUserAgent,
  enqueueUserAgentJob,
  getUserAgentOpsOverview,
  getUserAgentArticleDetail,
  getUserTodayDaily,
  ingestUserAgentEvent,
  listUserAgentArticles,
  listUserAgentRecommendations,
  refreshUserAgentRecommendations,
  regenerateUserTodayDaily,
  runUserAgentJobsNow,
  syncUserAgentPreferredLocale,
  syncUserAgentRequestLocale,
} from '../services/agent';
import { hydrateArticleRelatedAssets } from '../services/articleRelatedAssets';
import { generateWithLlm, getLlmDebugStatus, getLlmErrorInfo, getLlmStatus } from '../services/llm';
import { fetchTopMarketAssets } from '../services/marketTopAssets';
import { fetchOpenNewsCryptoNews, fetchOpenTwitterCryptoTweets, type NewsItem, type TweetItem } from '../services/openNews';
import {
  enqueueTopicSpecialGeneration,
  generateTopicSpecialPreviewViaDo,
  probeTopicSpecialDraftsViaDo,
  runTopicSpecialBatchViaDo,
} from '../services/topicSpecialCoordinator';
import { fetchTradeBrowse } from '../services/tradeBrowse';
import type { AppEnv } from '../types';
import { safeJsonParse } from '../utils/json';
import { putArticleMarkdownContent } from '../durableObjects/userAgentArticleContentStore';
import { fetchNewsHeadlines } from '../durableObjects/userAgentRss';
import { fetchDexScreenerMemeHeat } from '../services/dexScreener';

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

function normalizeArticleTimeBound(raw: string | undefined, bound: 'from' | 'to'): string | null {
  const normalized = raw?.trim();
  if (!normalized) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const startMs = Date.parse(`${normalized}T00:00:00.000Z`);
    if (!Number.isFinite(startMs)) return null;
    return bound === 'from'
      ? new Date(startMs).toISOString()
      : new Date(startMs + 24 * 60 * 60 * 1000).toISOString();
  }

  const parsedMs = Date.parse(normalized);
  if (!Number.isFinite(parsedMs)) return null;
  return new Date(parsedMs).toISOString();
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

function estimatePromptTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.ceil(normalized.length / 4);
}

function buildLargeProbePacket(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) =>
    `- Signal ${index + 1}: Ethereum ETF positioning, stablecoin liquidity, perp basis, meme beta, and macro rate expectations remain mixed across risk assets.`,
  ).join('\n');
}

function buildLlmProbeMessages(
  preset: string,
  body?: { system?: string; user?: string },
): Array<{ role: 'system' | 'user'; content: string }> {
  if (body?.system?.trim() && body?.user?.trim()) {
    return [
      { role: 'system', content: body.system.trim() },
      { role: 'user', content: body.user.trim() },
    ];
  }

  switch (preset) {
    case 'small_json':
      return [
        { role: 'system', content: 'Return strict JSON array only.' },
        { role: 'user', content: 'Return exactly [{"topic":"BTC","summary":"ok"}].' },
      ];
    case 'large_json': {
      const packet = buildLargeProbePacket(80);
      return [
        {
          role: 'system',
          content: 'You are a market topic generator. Return strict JSON array only.',
        },
        {
          role: 'user',
          content: [
            'Mission:',
            '- Return 3 topic drafts as strict JSON array only.',
            '- Each object must include topic, summary, related_assets, source_refs.',
            '',
            'Research packet:',
            packet,
          ].join('\n'),
        },
      ];
    }
    case 'large_markdown': {
      const packet = buildLargeProbePacket(120);
      return [
        {
          role: 'system',
          content: 'Write markdown only. Build a clear argument from evidence.',
        },
        {
          role: 'user',
          content: [
            'Topic: Ethereum Positioning and Yield Rotation',
            'Objective: write a useful market article.',
            '',
            'Research packet:',
            packet,
          ].join('\n'),
        },
      ];
    }
    case 'tiny':
    default:
      return [
        { role: 'system', content: 'Reply with exactly "ok".' },
        { role: 'user', content: 'ok' },
    ];
  }
}

const TOPIC_PROBE_NEWS_KEYWORDS = [
  'bitcoin',
  'ethereum',
  'crypto',
  'meme',
  'memecoin',
  'stablecoin',
  'etf',
  'fed',
  'interest rate',
  'treasury',
  'nasdaq',
  's&p 500',
];

const TOPIC_PROBE_TWITTER_KEYWORDS = [
  'bitcoin',
  'ethereum',
  'crypto',
  'meme',
  'memecoin',
  'doge',
  'dogecoin',
  'shib',
  'fed',
  'rates',
  'risk-on',
  'risk-off',
  'nasdaq',
  'etf',
  'stablecoin',
];

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

function toApiTransfer(row: {
  id: string;
  network_key: string;
  chain_id: number | null;
  from_address: string;
  to_address: string;
  token_address: string | null;
  token_symbol: string | null;
  token_decimals: number;
  amount_input: string;
  amount_raw: string;
  tx_value: string;
  tx_hash: string | null;
  status: 'created' | 'submitted' | 'confirmed' | 'failed';
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
}) {
  return {
    id: row.id,
    source: 'app' as const,
    networkKey: row.network_key,
    chainId: row.chain_id,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    tokenAddress: row.token_address,
    tokenSymbol: row.token_symbol,
    tokenDecimals: row.token_decimals,
    amountInput: row.amount_input,
    amountRaw: row.amount_raw,
    txValue: row.tx_value,
    txHash: row.tx_hash,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
  };
}

function safeJsonRecord(value: string): Record<string, unknown> | null {
  const parsed = safeJsonParse<Record<string, unknown>>(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
  return parsed;
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
      recommendations: doRecommendations.map((row) => {
        return {
          id: row.id,
          kind: row.category,
          title: row.asset_name,
          content: row.reason,
          asset: {
            symbol: row.asset_symbol ?? row.asset_name,
            chain: row.asset_chain,
            contract: row.asset_contract,
            name: row.asset_display_name ?? row.asset_name,
            image: row.asset_image ?? null,
            price_change_percentage_24h: row.asset_price_change_24h,
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
    const fromRaw = c.req.query('from');
    const toRaw = c.req.query('to');
    const limit = limitRaw ? Number(limitRaw) : 20;
    const createdAfter = normalizeArticleTimeBound(fromRaw, 'from');
    const createdBefore = normalizeArticleTimeBound(toRaw, 'to');
    if (fromRaw && !createdAfter) {
      return c.json({ error: 'invalid_from' }, 400);
    }
    if (toRaw && !createdBefore) {
      return c.json({ error: 'invalid_to' }, 400);
    }
    if (createdAfter && createdBefore && Date.parse(createdAfter) >= Date.parse(createdBefore)) {
      return c.json({ error: 'invalid_range' }, 400);
    }
    const articles = await listUserAgentArticles(c.env, userId, {
      articleType,
      limit: Number.isFinite(limit) ? limit : 20,
      createdAfter,
      createdBefore,
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
    const relatedAssets = await hydrateArticleRelatedAssets(c.env, detail.relatedAssets ?? []);
    return c.json({
      article: {
        ...toApiArticle(detail.article),
      },
      markdown: detail.markdown,
      relatedAssets,
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

  app.get('/v1/agent/ops/overview', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));

    const overview = await getUserAgentOpsOverview(c.env, userId, {
      recentJobLimit: 12,
      recentEventLimit: 12,
      recommendationLimit: 6,
      articleLimit: 6,
      watchlistLimit: 8,
      transferLimit: 8,
    });

    return c.json({
      generatedAt: overview.generated_at,
      llm: getLlmStatus(c.env),
      locale: overview.locale,
      activity: {
        isActive: overview.activity.is_active,
        activeUntil: overview.activity.active_until,
        eventCount: overview.activity.event_count,
        recentEvents: overview.activity.recent_events.map((event) => ({
          id: event.id,
          type: event.event_type,
          occurredAt: event.occurred_at,
          receivedAt: event.received_at,
          dedupeKey: event.dedupe_key,
          payload: safeJsonRecord(event.payload_json),
        })),
      },
      daily: {
        date: overview.daily.date,
        status: overview.daily.status,
        article: overview.daily.article ? toApiArticle(overview.daily.article) : null,
        lastReadyArticle: overview.daily.last_ready_article ? toApiArticle(overview.daily.last_ready_article) : null,
      },
      jobs: {
        counts: overview.jobs.counts,
        nextQueuedRunAt: overview.jobs.next_queued_run_at,
        recent: overview.jobs.recent.map((job) => ({
          id: job.id,
          type: job.job_type,
          runAt: job.run_at,
          status: job.status,
          retryCount: job.retry_count,
          jobKey: job.job_key,
          createdAt: job.created_at,
          updatedAt: job.updated_at,
          payload: safeJsonRecord(job.payload_json),
        })),
      },
      recommendations: {
        dirty: overview.recommendations.dirty,
        lastRefreshedAt: overview.recommendations.last_refreshed_at,
        count: overview.recommendations.count,
        items: overview.recommendations.items.map((row) => ({
          id: row.id,
          kind: row.category,
          title: row.asset_name,
          content: row.reason,
          asset: {
            symbol: row.asset_symbol ?? row.asset_name,
            chain: row.asset_chain,
            contract: row.asset_contract,
            name: row.asset_display_name ?? row.asset_name,
            image: row.asset_image ?? null,
            price_change_percentage_24h: row.asset_price_change_24h,
          },
          score: row.score,
          created_at: row.generated_at,
          valid_until: row.valid_until,
          source: 'do',
        })),
      },
      articles: {
        items: overview.articles.items.map((row) => toApiArticle(row)),
      },
      portfolio: {
        latestHourlySnapshot: overview.portfolio.latest_hourly_snapshot
          ? {
              bucketHourUtc: overview.portfolio.latest_hourly_snapshot.bucket_hour_utc,
              totalUsd: overview.portfolio.latest_hourly_snapshot.total_usd,
              holdingsCount: overview.portfolio.latest_hourly_snapshot.holdings_count,
              asOf: overview.portfolio.latest_hourly_snapshot.as_of,
              createdAt: overview.portfolio.latest_hourly_snapshot.created_at,
            }
          : null,
        latestDailySnapshot: overview.portfolio.latest_daily_snapshot
          ? {
              bucketDateUtc: overview.portfolio.latest_daily_snapshot.bucket_date_utc,
              totalUsd: overview.portfolio.latest_daily_snapshot.total_usd,
              asOf: overview.portfolio.latest_daily_snapshot.as_of,
              createdAt: overview.portfolio.latest_daily_snapshot.created_at,
            }
          : null,
        points24h: overview.portfolio.points_24h,
      },
      watchlist: {
        count: overview.watchlist.count,
        items: overview.watchlist.items,
      },
      transfers: {
        count: overview.transfers.count,
        items: overview.transfers.items.map((row) => toApiTransfer(row)),
      },
    });
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
      return c.json({ ok: false, llm, error: { message: 'llm_not_configured' } }, 503);
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
        maxRetryDelayMs: 2_000,
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
    try {
      const refreshed = await refreshUserAgentRecommendations(c.env, userId, { force: true });
      const recommendations = await listUserAgentRecommendations(c.env, userId, 10);
      return c.json({
        ok: true,
        refreshed,
        recommendations: recommendations.map((row) => ({
          id: row.id,
          kind: row.category,
          title: row.asset_name,
          content: row.reason,
          asset: {
            symbol: row.asset_symbol ?? row.asset_name,
            chain: row.asset_chain,
            contract: row.asset_contract,
            name: row.asset_display_name ?? row.asset_name,
            image: row.asset_image ?? null,
            price_change_percentage_24h: row.asset_price_change_24h,
          },
          score: row.score,
          created_at: row.generated_at,
          valid_until: row.valid_until,
          source: 'do',
        })),
      });
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: 'recommendations_refresh_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.post('/v1/agent/jobs/portfolio-snapshot/run', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    const now = new Date().toISOString();
    const result = await enqueueUserAgentJob(c.env, userId, {
      jobType: 'portfolio_snapshot',
      runAt: now,
      jobKey: `manual_portfolio_snapshot:${now.slice(0, 16)}`,
      payload: { trigger: 'manual' },
    });
    await runUserAgentJobsNow(c.env, userId);
    return c.json(result);
  });

  app.post('/v1/admin/llm/probe', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const body: {
      preset?: 'tiny' | 'small_json' | 'large_json' | 'large_markdown';
      repeat?: number;
      maxTokens?: number;
      temperature?: number;
      system?: string;
      user?: string;
    } = await c.req.json<{
      preset?: 'tiny' | 'small_json' | 'large_json' | 'large_markdown';
      repeat?: number;
      maxTokens?: number;
      temperature?: number;
      system?: string;
      user?: string;
    }>().catch(
      () =>
        ({
          preset: undefined,
          repeat: undefined,
          maxTokens: undefined,
          temperature: undefined,
          system: undefined,
          user: undefined,
        }),
    );

    const preset = body.preset ?? 'tiny';
    const repeat = Math.max(1, Math.min(3, Math.trunc(body.repeat ?? 1)));
    const messages = buildLlmProbeMessages(preset, body);
    const llm = await getLlmDebugStatus(c.env);
    const promptStats = {
      systemChars: messages[0]?.content.length ?? 0,
      userChars: messages[1]?.content.length ?? 0,
      totalChars: (messages[0]?.content.length ?? 0) + (messages[1]?.content.length ?? 0),
      systemEstimatedTokens: estimatePromptTokens(messages[0]?.content ?? ''),
      userEstimatedTokens: estimatePromptTokens(messages[1]?.content ?? ''),
      totalEstimatedTokens: estimatePromptTokens(messages.map((message) => message.content).join('\n')),
    };

    const results: Array<Record<string, unknown>> = [];
    for (let index = 0; index < repeat; index += 1) {
      const startedAt = Date.now();
      try {
        const result = await generateWithLlm(c.env, {
          messages,
          temperature: typeof body.temperature === 'number' ? body.temperature : 0.2,
          maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : 512,
          retryAttempts: 1,
          maxRetryDelayMs: 2_000,
        });
        results.push({
          attempt: index + 1,
          ok: true,
          elapsedMs: Date.now() - startedAt,
          provider: result.provider,
          model: result.model,
          fallbackFrom: result.fallbackFrom ?? null,
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
          textSnippet: result.text.slice(0, 400),
        });
      } catch (error) {
        results.push({
          attempt: index + 1,
          ok: false,
          elapsedMs: Date.now() - startedAt,
          error: getLlmErrorInfo(error),
        });
      }
    }

    return c.json({
      ok: results.every((item) => item.ok === true),
      llm,
      preset,
      repeat,
      promptStats,
      results,
    });
  });

  app.post('/v1/admin/llm/probe-with-topic-prefetch', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const body: {
      preset?: 'tiny' | 'small_json' | 'large_json' | 'large_markdown';
      maxTokens?: number;
      temperature?: number;
      system?: string;
      user?: string;
    } = await c.req.json<{
      preset?: 'tiny' | 'small_json' | 'large_json' | 'large_markdown';
      maxTokens?: number;
      temperature?: number;
      system?: string;
      user?: string;
    }>().catch(
      () =>
        ({
          preset: undefined,
          maxTokens: undefined,
          temperature: undefined,
          system: undefined,
          user: undefined,
        }),
    );

    const preset = body.preset ?? 'tiny';
    const startedPrefetchAt = Date.now();
    const [newsItems, twitterItems, rssHeadlines, marketAssets, memeHeatItems, tradeBrowse] = await Promise.all([
      fetchOpenNewsCryptoNews(c.env, {
        keywords: TOPIC_PROBE_NEWS_KEYWORDS,
        limit: 14,
      }).catch(() => [] as NewsItem[]),
      fetchOpenTwitterCryptoTweets(c.env, {
        keywords: TOPIC_PROBE_TWITTER_KEYWORDS,
        limit: 10,
      }).catch(() => [] as TweetItem[]),
      fetchNewsHeadlines(c.env).catch(() => [] as string[]),
      fetchTopMarketAssets(c.env, {
        name: 'marketCap',
        source: 'auto',
        limit: 20,
      }).catch(() => []),
      fetchDexScreenerMemeHeat().catch(() => []),
      fetchTradeBrowse(c.env).catch(() => ({
        generatedAt: new Date().toISOString(),
        topMovers: [],
        trendings: [],
        perps: [],
        predictions: [],
      })),
    ]);

    const messages = buildLlmProbeMessages(preset, body);
    const llm = await getLlmDebugStatus(c.env);
    const promptStats = {
      systemChars: messages[0]?.content.length ?? 0,
      userChars: messages[1]?.content.length ?? 0,
      totalChars: (messages[0]?.content.length ?? 0) + (messages[1]?.content.length ?? 0),
      systemEstimatedTokens: estimatePromptTokens(messages[0]?.content ?? ''),
      userEstimatedTokens: estimatePromptTokens(messages[1]?.content ?? ''),
      totalEstimatedTokens: estimatePromptTokens(messages.map((message) => message.content).join('\n')),
    };

    try {
      const startedLlmAt = Date.now();
      const result = await generateWithLlm(c.env, {
        messages,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.2,
        maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : 512,
        retryAttempts: 1,
        maxRetryDelayMs: 2_000,
      });
      return c.json({
        ok: true,
        llm,
        preset,
        promptStats,
        prefetchElapsedMs: Date.now() - startedPrefetchAt,
        llmElapsedMs: Date.now() - startedLlmAt,
        sourceCounts: {
          newsCount: newsItems.length,
          twitterCount: twitterItems.length,
          rssHeadlineCount: rssHeadlines.length,
          marketAssetCount: marketAssets.length,
          memeHeatCount: memeHeatItems.length,
          perpCount: tradeBrowse.perps.length,
          predictionCount: tradeBrowse.predictions.length,
        },
        result: {
          provider: result.provider,
          model: result.model,
          fallbackFrom: result.fallbackFrom ?? null,
          requestId: result.requestId ?? null,
          cfRay: result.cfRay ?? null,
          openaiProject: result.openaiProject ?? null,
          openaiOrganization: result.openaiOrganization ?? null,
          rateLimitRemainingRequests: result.rateLimitRemainingRequests ?? null,
          rateLimitRemainingTokens: result.rateLimitRemainingTokens ?? null,
          textSnippet: result.text.slice(0, 400),
        },
      });
    } catch (error) {
      return c.json({
        ok: false,
        llm,
        preset,
        promptStats,
        prefetchElapsedMs: Date.now() - startedPrefetchAt,
        sourceCounts: {
          newsCount: newsItems.length,
          twitterCount: twitterItems.length,
          rssHeadlineCount: rssHeadlines.length,
          marketAssetCount: marketAssets.length,
          memeHeatCount: memeHeatItems.length,
          perpCount: tradeBrowse.perps.length,
          predictionCount: tradeBrowse.predictions.length,
        },
        error: getLlmErrorInfo(error),
      }, 502);
    }
  });

  app.post('/v1/admin/llm/probe-topic-draft', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const body = await c.req.json<{
      slotKey?: string;
      compactDraftPacket?: boolean;
      draftRetryAttempts?: number;
      omitDraftHeadlineTape?: boolean;
      omitDraftNews?: boolean;
      omitDraftSocial?: boolean;
      omitDraftMemeHeat?: boolean;
      omitDraftSpot?: boolean;
      omitDraftPerps?: boolean;
      omitDraftPredictions?: boolean;
    }>().catch(
      () =>
        ({
          slotKey: undefined,
          compactDraftPacket: undefined,
          draftRetryAttempts: undefined,
          omitDraftHeadlineTape: undefined,
          omitDraftNews: undefined,
          omitDraftSocial: undefined,
          omitDraftMemeHeat: undefined,
          omitDraftSpot: undefined,
          omitDraftPerps: undefined,
          omitDraftPredictions: undefined,
        }) satisfies {
          slotKey?: string;
          compactDraftPacket?: boolean;
          draftRetryAttempts?: number;
          omitDraftHeadlineTape?: boolean;
          omitDraftNews?: boolean;
          omitDraftSocial?: boolean;
          omitDraftMemeHeat?: boolean;
          omitDraftSpot?: boolean;
          omitDraftPerps?: boolean;
          omitDraftPredictions?: boolean;
        },
    );
    try {
      const result = await probeTopicSpecialDraftsViaDo(c.env, {
        slotKey: typeof body.slotKey === 'string' ? body.slotKey : undefined,
        compactDraftPacket: body.compactDraftPacket === true,
        draftRetryAttempts: typeof body.draftRetryAttempts === 'number' ? body.draftRetryAttempts : undefined,
        omitDraftHeadlineTape: body.omitDraftHeadlineTape === true,
        omitDraftNews: body.omitDraftNews === true,
        omitDraftSocial: body.omitDraftSocial === true,
        omitDraftMemeHeat: body.omitDraftMemeHeat === true,
        omitDraftSpot: body.omitDraftSpot === true,
        omitDraftPerps: body.omitDraftPerps === true,
        omitDraftPredictions: body.omitDraftPredictions === true,
      });
      return c.json({
        ok: true,
        slotKey: result.slotKey,
        draftCount: result.drafts.length,
        drafts: result.drafts.map((draft) => ({
          editorId: draft.editorId,
          editorLabel: draft.editorLabel,
          topic: draft.topic,
          summary: draft.summary,
          relatedAssets: draft.relatedAssets,
          sourceRefs: draft.sourceRefs,
        })),
        debug: result.debug,
      });
    } catch (error) {
      return c.json({
        ok: false,
        error: 'topic_draft_probe_failed',
        details: getLlmErrorInfo(error),
      }, 502);
    }
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
    try {
      const result = await enqueueTopicSpecialGeneration(c.env, {
        force: body.force === true,
        trigger: 'admin',
      });
      return c.json({
        ok: true,
        jobId: result.jobId,
        deduped: result.deduped,
        slotKey: result.slotKey,
        status: result.status,
      }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = getLlmErrorInfo(error);
      console.error('topic_special_admin_run_failed', {
        userId,
        force: body.force === true,
        message,
        details,
      });
      return c.json(
        {
          ok: false,
          error: 'topic_special_run_failed',
          message,
          details,
        },
        502,
      );
    }
  });

  app.post('/v1/admin/topic-specials/run-now', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json<{ force?: boolean; slotKey?: string }>().catch(
      () =>
        ({
          force: undefined,
          slotKey: undefined,
        }) satisfies { force?: boolean; slotKey?: string },
    );
    try {
      const result = await runTopicSpecialBatchViaDo(c.env, {
        force: body.force === true,
        slotKey: typeof body.slotKey === 'string' ? body.slotKey : undefined,
      });
      return c.json({
        ok: true,
        slotKey: result.slotKey,
        generated: result.generated,
        skipped: result.skipped,
        totalInSlot: result.totalInSlot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = getLlmErrorInfo(error);
      console.error('topic_special_admin_run_now_failed', {
        userId,
        force: body.force === true,
        slotKey: typeof body.slotKey === 'string' ? body.slotKey : undefined,
        message,
        details,
      });
      return c.json(
        {
          ok: false,
          error: 'topic_special_run_now_failed',
          message,
          details,
        },
        502,
      );
    }
  });

  app.post('/v1/admin/topic-specials/r2-probe', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const key = `topic-special-probe/${new Date().toISOString()}.txt`;
    try {
      await c.env.AGENT_ARTICLES.put(key, 'ok');
      return c.json({ ok: true, key, bucket: 'AGENT_ARTICLES' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        {
          ok: false,
          error: 'topic_special_r2_probe_failed',
          key,
          message,
        },
        502,
      );
    }
  });

  app.post('/v1/admin/topic-specials/r2-probe-markdown', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json<{
      mode?: 'fixed' | 'preview';
      slotKey?: string;
      useTopicKey?: boolean;
      asciiOnly?: boolean;
    }>().catch(
      () =>
        ({
          mode: undefined,
          slotKey: undefined,
          useTopicKey: undefined,
          asciiOnly: undefined,
        }) satisfies {
          mode?: 'fixed' | 'preview';
          slotKey?: string;
          useTopicKey?: boolean;
          asciiOnly?: boolean;
        },
    );

    const mode = body.mode === 'preview' ? 'preview' : 'fixed';
    const articleId = crypto.randomUUID();
    let markdown = [
      '# Fixed Probe',
      '',
      'This is a controlled markdown probe for R2 writes.',
      '',
      '## Payload',
      'BTC, ETH, SOL, USDC',
      '',
      '## Lines',
      ...Array.from({ length: 48 }, (_, index) => `- Probe line ${index + 1}: testing topic markdown write behavior.`),
    ].join('\n');
    let r2Key = `topic-special-probe/${new Date().toISOString()}-${articleId}.md`;

    try {
      if (mode === 'preview') {
        const preview = await generateTopicSpecialPreviewViaDo(c.env, {
          force: true,
          slotKey: typeof body.slotKey === 'string' ? body.slotKey : undefined,
        });
        if (!preview.article) {
          return c.json({
            ok: false,
            error: 'topic_special_preview_empty',
            slotKey: preview.slotKey,
            skipped: preview.skipped,
          }, 409);
        }
        markdown = preview.article.markdown;
        if (body.useTopicKey === true) {
          r2Key = preview.article.r2Key;
        }
      } else if (body.useTopicKey === true) {
        const slotKey = typeof body.slotKey === 'string' && body.slotKey.trim() ? body.slotKey.trim() : '2026-03-15T12';
        r2Key = `special-topics/${slotKey}/probe-${articleId}.md`;
      }

      if (body.asciiOnly === true) {
        markdown = markdown
          .replaceAll('\u2018', "'")
          .replaceAll('\u2019', "'")
          .replaceAll('\u201c', '"')
          .replaceAll('\u201d', '"');
      }

      await putArticleMarkdownContent(c.env, articleId, r2Key, markdown);
      return c.json({
        ok: true,
        mode,
        r2Key,
        bytes: new TextEncoder().encode(markdown).byteLength,
        useTopicKey: body.useTopicKey === true,
        asciiOnly: body.asciiOnly === true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        {
          ok: false,
          error: 'topic_special_r2_probe_markdown_failed',
          mode,
          r2Key,
          bytes: new TextEncoder().encode(markdown).byteLength,
          useTopicKey: body.useTopicKey === true,
          asciiOnly: body.asciiOnly === true,
          message,
        },
        502,
      );
    }
  });

  app.post('/v1/admin/topic-specials/r2-probe-upload', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json<{
      markdown?: string;
      r2Key?: string;
    }>().catch(
      () =>
        ({
          markdown: undefined,
          r2Key: undefined,
        }) satisfies {
          markdown?: string;
          r2Key?: string;
        },
    );
    const markdown = typeof body.markdown === 'string' ? body.markdown : '';
    const r2Key = typeof body.r2Key === 'string' && body.r2Key.trim()
      ? body.r2Key.trim()
      : `topic-special-probe/upload-${new Date().toISOString()}-${crypto.randomUUID()}.md`;
    if (!markdown.trim()) {
      return c.json({ ok: false, error: 'invalid_markdown' }, 400);
    }
    try {
      await putArticleMarkdownContent(c.env, crypto.randomUUID(), r2Key, markdown);
      return c.json({
        ok: true,
        r2Key,
        bytes: new TextEncoder().encode(markdown).byteLength,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        {
          ok: false,
          error: 'topic_special_r2_probe_upload_failed',
          r2Key,
          bytes: new TextEncoder().encode(markdown).byteLength,
          message,
        },
        502,
      );
    }
  });

  app.post('/v1/admin/topic-specials/preview', async (c) => {
    const userId = c.get('userId');
    await syncUserAgentRequestLocale(c.env, userId, normalizePreferredLocale(c.req.header('accept-language')));
    if (!hasTopicSpecialAdminAccess(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json<{
      force?: boolean;
      slotKey?: string;
      compactDraftPacket?: boolean;
      draftRetryAttempts?: number;
      forceArticleFallback?: boolean;
      omitDraftHeadlineTape?: boolean;
      omitDraftNews?: boolean;
      omitDraftSocial?: boolean;
      omitDraftMemeHeat?: boolean;
      omitDraftSpot?: boolean;
      omitDraftPerps?: boolean;
      omitDraftPredictions?: boolean;
    }>().catch(
      () =>
        ({
          force: undefined,
          slotKey: undefined,
          compactDraftPacket: undefined,
          draftRetryAttempts: undefined,
          forceArticleFallback: undefined,
          omitDraftHeadlineTape: undefined,
          omitDraftNews: undefined,
          omitDraftSocial: undefined,
          omitDraftMemeHeat: undefined,
          omitDraftSpot: undefined,
          omitDraftPerps: undefined,
          omitDraftPredictions: undefined,
        }) satisfies {
          force?: boolean;
          slotKey?: string;
          compactDraftPacket?: boolean;
          draftRetryAttempts?: number;
          forceArticleFallback?: boolean;
          omitDraftHeadlineTape?: boolean;
          omitDraftNews?: boolean;
          omitDraftSocial?: boolean;
          omitDraftMemeHeat?: boolean;
          omitDraftSpot?: boolean;
          omitDraftPerps?: boolean;
          omitDraftPredictions?: boolean;
        },
    );
    try {
      const result = await generateTopicSpecialPreviewViaDo(c.env, {
        force: body.force === true,
        slotKey: typeof body.slotKey === 'string' ? body.slotKey : undefined,
        compactDraftPacket: body.compactDraftPacket === true,
        draftRetryAttempts: typeof body.draftRetryAttempts === 'number' ? body.draftRetryAttempts : undefined,
        forceArticleFallback: body.forceArticleFallback === true,
        omitDraftHeadlineTape: body.omitDraftHeadlineTape === true,
        omitDraftNews: body.omitDraftNews === true,
        omitDraftSocial: body.omitDraftSocial === true,
        omitDraftMemeHeat: body.omitDraftMemeHeat === true,
        omitDraftSpot: body.omitDraftSpot === true,
        omitDraftPerps: body.omitDraftPerps === true,
        omitDraftPredictions: body.omitDraftPredictions === true,
      });
      return c.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = getLlmErrorInfo(error);
      return c.json(
        {
          ok: false,
          error: 'topic_special_preview_failed',
          message,
          details,
        },
        502,
      );
    }
  });

}
