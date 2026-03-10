import type { AgentEventRecord } from '../agent/events';
import type { Bindings } from '../types';

type AgentEventIngestResult = {
  ok: true;
  eventId: string;
  deduped: boolean;
  sequence: number;
};

type AgentJobType = 'daily_digest' | 'recommendation_refresh' | 'topic_generation';

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

type AgentRegenerateTodayDailyResponse = {
  ok: true;
  deletedArticleIds: string[];
  article: AgentArticle | null;
};

type AgentPortfolioSnapshotPoint = {
  ts: string;
  total_usd: number;
};

export type AgentTransfer = {
  id: string;
  chain_id: number;
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
};

export type AgentWatchlistAsset = {
  id: string;
  watch_type: 'crypto' | 'perps' | 'stock' | 'prediction';
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

export type AgentChatRequest = {
  sessionId: string;
  page: string;
  pageContext?: Record<string, string>;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
};

export type AgentChatResponse = {
  reply: string;
  sessionId: string;
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
  regenerateTodayDailyRpc(userId: string): Promise<AgentRegenerateTodayDailyResponse>;
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
  createTransferRpc(
    userId: string,
    input: {
      id: string;
      chainId: number;
      fromAddress: string;
      toAddress: string;
      tokenAddress?: string | null;
      tokenSymbol?: string | null;
      tokenDecimals: number;
      amountInput: string;
      amountRaw: string;
      txValue: string;
      status: AgentTransfer['status'];
      idempotencyKey?: string | null;
      txHash?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      submittedAt?: string | null;
      confirmedAt?: string | null;
    },
  ): Promise<{ transfer: AgentTransfer; deduped: boolean }>;
  updateTransferRpc(
    userId: string,
    transferId: string,
    input: {
      status?: AgentTransfer['status'];
      txHash?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      submittedAt?: string | null;
      confirmedAt?: string | null;
    },
  ): Promise<{ transfer: AgentTransfer | null }>;
  getTransferRpc(userId: string, transferId: string): Promise<{ transfer: AgentTransfer | null }>;
  listTransfersRpc(
    userId: string,
    options?: {
      limit?: number;
      status?: AgentTransfer['status'];
    },
  ): Promise<{ transfers: AgentTransfer[] }>;
  listWatchlistAssetsRpc(userId: string, limit?: number): Promise<{ assets: AgentWatchlistAsset[] }>;
  upsertWatchlistAssetRpc(
    userId: string,
    input: {
      watchType?: string | null;
      itemId?: string | null;
      chain?: string | null;
      contract?: string | null;
      symbol?: string | null;
      name?: string | null;
      image?: string | null;
      source?: string | null;
      change24h?: number | null;
      externalUrl?: string | null;
    },
  ): Promise<{ asset: AgentWatchlistAsset }>;
  removeWatchlistAssetRpc(
    userId: string,
    input: {
      id?: string | null;
      chain?: string | null;
      contract?: string | null;
    },
  ): Promise<{ removed: boolean }>;
  chatRpc(
    userId: string,
    request: AgentChatRequest,
  ): Promise<AgentChatResponse>;
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

export async function regenerateUserTodayDaily(
  env: Bindings,
  userId: string,
): Promise<AgentRegenerateTodayDailyResponse> {
  const stub = getUserAgentStub(env, userId);
  return stub.regenerateTodayDailyRpc(userId);
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

export async function createUserTransfer(
  env: Bindings,
  userId: string,
  input: Parameters<UserAgentRpcStub['createTransferRpc']>[1],
): Promise<{ transfer: AgentTransfer; deduped: boolean }> {
  const stub = getUserAgentStub(env, userId);
  return stub.createTransferRpc(userId, input);
}

export async function updateUserTransfer(
  env: Bindings,
  userId: string,
  transferId: string,
  input: Parameters<UserAgentRpcStub['updateTransferRpc']>[2],
): Promise<AgentTransfer | null> {
  const stub = getUserAgentStub(env, userId);
  const data = await stub.updateTransferRpc(userId, transferId, input);
  return data.transfer ?? null;
}

export async function getUserTransfer(
  env: Bindings,
  userId: string,
  transferId: string,
): Promise<AgentTransfer | null> {
  const stub = getUserAgentStub(env, userId);
  try {
    const data = await stub.getTransferRpc(userId, transferId);
    return data.transfer ?? null;
  } catch {
    return null;
  }
}

export async function listUserTransfers(
  env: Bindings,
  userId: string,
  options?: {
    limit?: number;
    status?: AgentTransfer['status'];
  },
): Promise<AgentTransfer[]> {
  const stub = getUserAgentStub(env, userId);
  try {
    const data = await stub.listTransfersRpc(userId, options);
    return data.transfers ?? [];
  } catch {
    return [];
  }
}

export async function listUserWatchlistAssets(
  env: Bindings,
  userId: string,
  limit = 50,
): Promise<AgentWatchlistAsset[]> {
  const stub = getUserAgentStub(env, userId);
  try {
    const data = await stub.listWatchlistAssetsRpc(userId, limit);
    return data.assets ?? [];
  } catch {
    return [];
  }
}

export async function upsertUserWatchlistAsset(
  env: Bindings,
  userId: string,
  input: {
    watchType?: string | null;
    itemId?: string | null;
    chain?: string | null;
    contract?: string | null;
    symbol?: string | null;
    name?: string | null;
    image?: string | null;
    source?: string | null;
    change24h?: number | null;
    externalUrl?: string | null;
  },
): Promise<AgentWatchlistAsset> {
  const stub = getUserAgentStub(env, userId);
  const data = await stub.upsertWatchlistAssetRpc(userId, input);
  return data.asset;
}

export async function removeUserWatchlistAsset(
  env: Bindings,
  userId: string,
  input: {
    id?: string | null;
    chain?: string | null;
    contract?: string | null;
  },
): Promise<boolean> {
  const stub = getUserAgentStub(env, userId);
  const data = await stub.removeWatchlistAssetRpc(userId, input);
  return data.removed === true;
}

export async function chatWithUserAgent(
  env: Bindings,
  userId: string,
  request: AgentChatRequest,
): Promise<AgentChatResponse> {
  const stub = getUserAgentStub(env, userId);
  return stub.chatRpc(userId, request);
}
