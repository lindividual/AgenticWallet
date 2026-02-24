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

type UserAgentRpcStub = DurableObjectStub & {
  ingestEventRpc(event: AgentEventRecord): Promise<AgentEventIngestResult>;
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
