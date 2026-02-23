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

export async function ingestUserAgentEvent(
  env: Bindings,
  userId: string,
  event: AgentEventRecord,
): Promise<AgentEventIngestResult> {
  const id = env.USER_AGENT.idFromName(userId);
  const stub = env.USER_AGENT.get(id);
  const response = await stub.fetch(
    new Request('https://user-agent.internal/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`user_agent_do_ingest_failed: ${response.status} ${body}`);
  }

  return response.json<AgentEventIngestResult>();
}

export async function listUserAgentRecommendations(
  env: Bindings,
  userId: string,
  limit = 10,
): Promise<AgentRecommendation[]> {
  const id = env.USER_AGENT.idFromName(userId);
  const stub = env.USER_AGENT.get(id);
  const response = await stub.fetch(
    new Request(`https://user-agent.internal/recommendations?limit=${encodeURIComponent(String(limit))}`, {
      method: 'GET',
    }),
  );
  if (!response.ok) {
    return [];
  }
  const data = await response.json<AgentRecommendationsResponse>();
  return data.recommendations ?? [];
}

export async function listUserAgentArticles(
  env: Bindings,
  userId: string,
  options?: {
    limit?: number;
    articleType?: string;
  },
): Promise<AgentArticle[]> {
  const id = env.USER_AGENT.idFromName(userId);
  const stub = env.USER_AGENT.get(id);
  const params = new URLSearchParams();
  params.set('limit', String(options?.limit ?? 20));
  if (options?.articleType) {
    params.set('type', options.articleType);
  }
  const response = await stub.fetch(
    new Request(`https://user-agent.internal/articles?${params.toString()}`, {
      method: 'GET',
    }),
  );
  if (!response.ok) {
    return [];
  }
  const data = await response.json<AgentArticlesResponse>();
  return data.articles ?? [];
}

export async function getUserAgentArticleDetail(
  env: Bindings,
  userId: string,
  articleId: string,
): Promise<AgentArticleDetailResponse | null> {
  const id = env.USER_AGENT.idFromName(userId);
  const stub = env.USER_AGENT.get(id);
  const response = await stub.fetch(
    new Request(`https://user-agent.internal/articles/${encodeURIComponent(articleId)}`, {
      method: 'GET',
    }),
  );
  if (response.status === 404) return null;
  if (!response.ok) return null;
  return response.json<AgentArticleDetailResponse>();
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
  const id = env.USER_AGENT.idFromName(userId);
  const stub = env.USER_AGENT.get(id);
  const response = await stub.fetch(
    new Request('https://user-agent.internal/jobs/enqueue', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        ...options,
      }),
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`user_agent_do_enqueue_job_failed: ${response.status} ${body}`);
  }

  return response.json<{ ok: true; jobId: string; deduped: boolean }>();
}

export async function runUserAgentJobsNow(env: Bindings, userId: string): Promise<void> {
  const id = env.USER_AGENT.idFromName(userId);
  const stub = env.USER_AGENT.get(id);
  const response = await stub.fetch(
    new Request('https://user-agent.internal/jobs/run-now', {
      method: 'POST',
    }),
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`user_agent_do_run_jobs_failed: ${response.status} ${body}`);
  }
}
