const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
const ADMIN_TOKEN_KEY = 'agentic_wallet_admin_token';

export type WalletSummary = {
  address: string;
  provider: string;
  chainAccounts?: Array<{
    networkKey: string;
    chainId: number | null;
    protocol: 'evm' | 'svm' | 'tvm' | 'btc';
    address: string;
  }>;
};

export type AgentRecommendation = {
  id: string;
  kind: string;
  title: string;
  content: string;
  asset?: {
    symbol: string;
    chain: string | null;
    contract: string | null;
    name: string;
    image: string | null;
    price_change_percentage_24h: number | null;
  };
  score?: number;
  created_at: string;
  valid_until?: string;
  source: 'do';
};

export type AgentArticle = {
  id: string;
  type: 'daily' | 'topic';
  title: string;
  summary: string;
  mdKey: string;
  tags: string[];
  created_at: string;
  status: string;
};

export type AgentArticleRelatedAsset = {
  symbol: string;
  market_type: 'spot' | 'perp' | 'prediction' | null;
  market_item_id: string | null;
  asset_id: string | null;
  chain: string | null;
  contract: string | null;
  name: string;
  image: string | null;
  price_change_percentage_24h: number | null;
};

export type AgentArticleDetailResponse = {
  article: AgentArticle;
  markdown: string;
  relatedAssets: AgentArticleRelatedAsset[];
};

export type AgentTodayDailyResponse = {
  date: string;
  status: 'ready' | 'generating' | 'failed' | 'stale';
  article: AgentArticle | null;
  lastReadyArticle: AgentArticle | null;
};

export type AgentOpsEvent = {
  id: string;
  type: string;
  occurredAt: string;
  receivedAt: string;
  dedupeKey: string | null;
  payload: Record<string, unknown> | null;
};

export type AgentOpsJob = {
  id: string;
  type: 'daily_digest' | 'portfolio_snapshot';
  runAt: string;
  status: string;
  retryCount: number;
  jobKey: string | null;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, unknown> | null;
  result: unknown | null;
};

export type PortfolioSnapshotPoint = {
  ts: string;
  total_usd: number;
};

export type TransferRecord = {
  id: string;
  source: 'app' | 'sim';
  networkKey: string;
  chainId: number | null;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number;
  amountInput: string;
  amountRaw: string;
  txValue: string;
  txHash: string | null;
  status: 'created' | 'submitted' | 'confirmed' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
};

export type WatchlistAsset = {
  id: string;
  watch_type: 'crypto' | 'perps' | 'prediction';
  item_id: string | null;
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  image: string | null;
  source: string | null;
  change_24h: number | null;
  external_url: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentOpsOverviewResponse = {
  generatedAt: string;
  llm: {
    enabled: boolean;
    provider: string;
    model: string;
    baseUrl: string;
    fallbackEnabled: boolean;
    fallbackProvider: string;
    fallbackModel: string;
    fallbackBaseUrl: string;
  };
  locale: {
    preferred: string | null;
    request: string | null;
    effective: string | null;
  };
  activity: {
    isActive: boolean;
    activeUntil: string | null;
    eventCount: number;
    recentEvents: AgentOpsEvent[];
  };
  daily: AgentTodayDailyResponse;
  jobs: {
    counts: {
      queued: number;
      running: number;
      succeeded: number;
      failed: number;
    };
    nextQueuedRunAt: string | null;
    recent: AgentOpsJob[];
  };
  recommendations: {
    dirty: boolean;
    lastRefreshedAt: string | null;
    count: number;
    items: AgentRecommendation[];
  };
  articles: {
    items: AgentArticle[];
  };
  portfolio: {
    latestHourlySnapshot: {
      bucketHourUtc: string;
      totalUsd: number;
      holdingsCount: number;
      asOf: string;
      createdAt: string;
    } | null;
    latestDailySnapshot: {
      bucketDateUtc: string;
      totalUsd: number;
      asOf: string;
      createdAt: string;
    } | null;
    points24h: PortfolioSnapshotPoint[];
  };
  watchlist: {
    count: number;
    items: WatchlistAsset[];
  };
  transfers: {
    count: number;
    items: TransferRecord[];
  };
};

export type AdminUserSummary = {
  id: string;
  handle: string;
  displayName: string;
  createdAt: string;
  lastLoginAt: string | null;
};

export type AdminUserAgentListItem = {
  user: AdminUserSummary;
  walletAddress: string | null;
  overview: {
    generatedAt: string | null;
    activity: {
      isActive: boolean;
      activeUntil: string | null;
      eventCount: number;
    };
    daily: {
      status: 'ready' | 'generating' | 'failed' | 'stale' | 'unknown';
      articleTitle: string | null;
    };
    jobs: {
      counts: {
        queued: number;
        running: number;
        succeeded: number;
        failed: number;
      };
      nextQueuedRunAt: string | null;
    };
    recommendations: {
      count: number;
      dirty: boolean;
    };
    articles: {
      latestTitle: string | null;
    };
    portfolio: {
      latestTotalUsd: number | null;
    };
  };
};

export type AdminUserAgentListResponse = {
  total: number;
  items: AdminUserAgentListItem[];
};

export type AdminUserAgentDetailResponse = {
  user: AdminUserSummary;
  wallet: WalletSummary | null;
  overview: AgentOpsOverviewResponse;
};

export type AgentPromptConfigResponse = {
  basePromptText: string;
  updatedAt: string | null;
};

export type AgentPromptSkillResponse = {
  slug: string;
  name: string;
  description: string;
  promptText: string;
  enabled: boolean;
  sortOrder: number;
  updatedAt: string | null;
};

export type TopicAgentJob = {
  id: string;
  slotKey: string;
  force: boolean;
  trigger: string;
  status: 'queued' | 'staged' | 'running' | 'succeeded' | 'failed';
  retryCount: number;
  runAt: string;
  result: unknown | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type TopicAgentArticle = {
  id: string;
  slotKey: string;
  topicSlug: string;
  title: string;
  summary: string;
  r2Key: string;
  generatedAt: string;
  status: string;
};

export type TopicAgentOverviewResponse = {
  generatedAt: string;
  counts: {
    queued: number;
    staged: number;
    running: number;
    succeeded: number;
    failed: number;
  };
  activeSlotKeys: string[];
  recentJobs: TopicAgentJob[];
  recentArticles: TopicAgentArticle[];
};

type AuthMode = 'none' | 'admin';

async function requestJson<T>(path: string, init?: RequestInit, authMode: AuthMode = 'none'): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  headers.set('Content-Type', 'application/json');

  if (authMode === 'admin') {
    const token = getAdminToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { error?: string; message?: string }).error ?? (data as { message?: string }).message ?? 'request_failed');
  }
  return data as T;
}

export function setAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_KEY, token.trim());
}

export function getAdminToken(): string | null {
  return localStorage.getItem(ADMIN_TOKEN_KEY);
}

export function clearAdminToken(): void {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

export async function validateAdminToken(): Promise<void> {
  await requestJson<AdminUserAgentListResponse>('/v1/admin/user-agents?limit=1', { method: 'GET' }, 'admin');
}

export async function getAdminUserAgents(input?: { query?: string; limit?: number }): Promise<AdminUserAgentListResponse> {
  const params = new URLSearchParams();
  if (input?.query?.trim()) params.set('query', input.query.trim());
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return requestJson<AdminUserAgentListResponse>(`/v1/admin/user-agents${suffix}`, { method: 'GET' }, 'admin');
}

export async function getAdminUserAgentDetail(userId: string): Promise<AdminUserAgentDetailResponse> {
  return requestJson<AdminUserAgentDetailResponse>(`/v1/admin/user-agents/${userId}`, { method: 'GET' }, 'admin');
}

export async function getAdminUserAgentArticleDetail(
  userId: string,
  articleId: string,
): Promise<AgentArticleDetailResponse> {
  return requestJson<AgentArticleDetailResponse>(
    `/v1/admin/user-agents/${userId}/articles/${articleId}`,
    { method: 'GET' },
    'admin',
  );
}

export async function getAdminTopicAgentOverview(): Promise<TopicAgentOverviewResponse> {
  return requestJson<TopicAgentOverviewResponse>('/v1/admin/topic-agent/overview', { method: 'GET' }, 'admin');
}

export async function getAdminAgentPromptConfig(): Promise<AgentPromptConfigResponse> {
  return requestJson<AgentPromptConfigResponse>('/v1/admin/agent/prompt-config', { method: 'GET' }, 'admin');
}

export async function saveAdminAgentPromptConfig(input: {
  basePromptText: string;
}): Promise<AgentPromptConfigResponse> {
  return requestJson<AgentPromptConfigResponse>(
    '/v1/admin/agent/prompt-config',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    'admin',
  );
}

export async function getAdminAgentSkills(): Promise<{ skills: AgentPromptSkillResponse[] }> {
  return requestJson<{ skills: AgentPromptSkillResponse[] }>('/v1/admin/agent/skills', { method: 'GET' }, 'admin');
}

export async function saveAdminAgentSkills(input: {
  skills: Array<{
    slug: string;
    name: string;
    description: string;
    promptText: string;
    enabled: boolean;
    sortOrder: number;
  }>;
}): Promise<{ skills: AgentPromptSkillResponse[] }> {
  return requestJson<{ skills: AgentPromptSkillResponse[] }>(
    '/v1/admin/agent/skills',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    'admin',
  );
}

export async function enqueueTopicAgentRun(input?: { force?: boolean }) {
  return requestJson<{ ok: true; jobId: string; deduped: boolean; slotKey: string; status: string }>(
    '/v1/admin/topic-specials/run',
    {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    },
    'admin',
  );
}

export async function runTopicAgentNow(input?: { force?: boolean; slotKey?: string }) {
  return requestJson<{ ok: true; slotKey: string; generated: number; skipped: number; totalInSlot: number }>(
    '/v1/admin/topic-specials/run-now',
    {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    },
    'admin',
  );
}
