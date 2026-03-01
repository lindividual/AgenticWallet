import type { AgentEventRecord } from '../agent/events';
import type { Bindings } from '../types';

type AgentEventIngestResult = {
  ok: true;
  eventId: string;
  deduped: boolean;
  sequence: number;
};

type AgentJobType = 'daily_digest' | 'recommendation_refresh' | 'topic_generation' | 'cleanup';

export type AgentRecommendation = {
  id: string;
  category: string;
  asset_name: string;
  asset_symbol: string | null;
  asset_chain: string | null;
  asset_contract: string | null;
  asset_display_name: string | null;
  asset_image: string | null;
  asset_price_change_24h: number | null;
  reason: string;
  score: number;
  generated_at: string;
  valid_until: string | null;
};

export type AgentArticle = {
  id: string;
  article_type: string;
  title: string;
  summary: string;
  r2_key: string;
  tags_json: string;
  created_at: string;
  status: string;
};

type AgentRecommendationsResponse = {
  recommendations: AgentRecommendation[];
};

type AgentArticlesResponse = {
  articles: AgentArticle[];
};

type AgentArticleDetailResponse = {
  article: AgentArticle;
  markdown: string;
};

type AgentTodayDailyResponse = {
  date: string;
  status: 'ready' | 'generating' | 'failed' | 'stale';
  article: AgentArticle | null;
  lastReadyArticle: AgentArticle | null;
};

type AgentPortfolioSnapshotPoint = {
  ts: string;
  total_usd: number;
};

type UserAgentRpcStub = DurableObjectStub & {
  ingestEventRpc(event: AgentEventRecord): Promise<AgentEventIngestResult>;
  setUserLocaleRpc(userId: string, locale: string | null): Promise<{ ok: true }>;
  setRequestLocaleRpc(userId: string, locale: string | null): Promise<{ ok: true }>;
  listRecommendationsRpc(userId: string, limit?: number): Promise<AgentRecommendationsResponse>;
  listArticlesRpc(
    userId: string,
    options?: {
      limit?: number;
      articleType?: string;
    },
  ): Promise<AgentArticlesResponse>;
  getArticleDetailRpc(userId: string, articleId: string): Promise<AgentArticleDetailResponse | null>;
  getTodayDailyRpc(userId: string): Promise<AgentTodayDailyResponse>;
  enqueueJobRpc(
    userId: string,
    options: {
      jobType: AgentJobType;
      runAt?: string;
      payload?: Record<string, unknown>;
      jobKey?: string;
    },
  ): Promise<{ ok: true; jobId: string; deduped: boolean }>;
  runJobsNowRpc(userId: string): Promise<{ ok: true }>;
  savePortfolioSnapshotRpc(
    userId: string,
    input: { totalUsd: number; holdings: unknown[]; asOf?: string },
  ): Promise<{ ok: true }>;
  listPortfolioSnapshotsRpc(
    userId: string,
    period: '24h' | '7d' | '30d',
  ): Promise<{ points: AgentPortfolioSnapshotPoint[] }>;
};

function getUserAgentStub(env: Bindings, userId: string): UserAgentRpcStub {
  const id = env.USER_AGENT.idFromName(userId);
  return env.USER_AGENT.get(id) as UserAgentRpcStub;
}

export async function ingestUserAgentEvent(
  env: Bindings,
  userId: string,
  event: AgentEventRecord,
): Promise<AgentEventIngestResult> {
  const stub = getUserAgentStub(env, userId);
  return stub.ingestEventRpc(event);
}

export async function syncUserAgentRequestLocale(env: Bindings, userId: string, locale: string | null): Promise<void> {
  const stub = getUserAgentStub(env, userId);
  try {
    await stub.setRequestLocaleRpc(userId, locale);
  } catch {
    // Ignore request locale sync failures. Content generation falls back to defaults.
  }
}

export async function syncUserAgentPreferredLocale(env: Bindings, userId: string, locale: string | null): Promise<void> {
  const stub = getUserAgentStub(env, userId);
  try {
    await stub.setUserLocaleRpc(userId, locale);
  } catch {
    // Ignore user locale sync failures. Content generation falls back to defaults.
  }
}

export async function listUserAgentRecommendations(
  env: Bindings,
  userId: string,
  limit = 10,
): Promise<AgentRecommendation[]> {
  const stub = getUserAgentStub(env, userId);
  try {
    const data = await stub.listRecommendationsRpc(userId, limit);
    return data.recommendations ?? [];
  } catch {
    return [];
  }
}

export async function listUserAgentArticles(
  env: Bindings,
  userId: string,
  options?: {
    limit?: number;
    articleType?: string;
  },
): Promise<AgentArticle[]> {
  const stub = getUserAgentStub(env, userId);
  try {
    const data = await stub.listArticlesRpc(userId, options);
    return data.articles ?? [];
  } catch {
    return [];
  }
}

export async function getUserAgentArticleDetail(
  env: Bindings,
  userId: string,
  articleId: string,
): Promise<AgentArticleDetailResponse | null> {
  const stub = getUserAgentStub(env, userId);
  try {
    return await stub.getArticleDetailRpc(userId, articleId);
  } catch {
    return null;
  }
}

export async function getUserTodayDaily(
  env: Bindings,
  userId: string,
): Promise<AgentTodayDailyResponse | null> {
  const stub = getUserAgentStub(env, userId);
  try {
    return await stub.getTodayDailyRpc(userId);
  } catch {
    return null;
  }
}

export async function enqueueUserAgentJob(
  env: Bindings,
  userId: string,
  options: {
    jobType: AgentJobType;
    runAt?: string;
    payload?: Record<string, unknown>;
    jobKey?: string;
  },
): Promise<{ ok: true; jobId: string; deduped: boolean }> {
  const stub = getUserAgentStub(env, userId);
  return stub.enqueueJobRpc(userId, options);
}

export async function runUserAgentJobsNow(env: Bindings, userId: string): Promise<void> {
  const stub = getUserAgentStub(env, userId);
  await stub.runJobsNowRpc(userId);
}

export async function saveUserPortfolioSnapshot(
  env: Bindings,
  userId: string,
  input: { totalUsd: number; holdings: unknown[]; asOf?: string },
): Promise<void> {
  const stub = getUserAgentStub(env, userId);
  await stub.savePortfolioSnapshotRpc(userId, input);
}

export async function listUserPortfolioSnapshots(
  env: Bindings,
  userId: string,
  period: '24h' | '7d' | '30d',
): Promise<AgentPortfolioSnapshotPoint[]> {
  const stub = getUserAgentStub(env, userId);
  try {
    const data = await stub.listPortfolioSnapshotsRpc(userId, period);
    return data.points ?? [];
  } catch {
    return [];
  }
}
