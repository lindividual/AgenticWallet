const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
const TOKEN_KEY = 'agentic_wallet_access_token';

export type RegisterOptionsResponse = {
  userId: string;
  challengeId: string;
  options: Record<string, unknown>;
};

export type LoginOptionsResponse = {
  challengeId: string;
  options: Record<string, unknown>;
};

export type PayVerifyOptionsResponse = {
  challengeId: string;
  options: Record<string, unknown>;
};

export type AuthVerifyResponse = {
  verified: boolean;
  accessToken: string;
  sessionExpiresAt: string;
  user: {
    id: string;
    handle: string;
    displayName: string;
  };
  wallet: {
    address: string;
    provider: string;
    chainAccounts?: Array<{
      chainId: number;
      address: string;
    }>;
  } | null;
};

export type PayVerifyConfirmResponse = {
  verified: boolean;
  verifiedAt: string;
  scope: 'payment';
};

export type MeResponse = {
  user: {
    id: string;
    handle: string;
    displayName: string;
  };
  wallet: {
    address: string;
    provider: string;
    chainAccounts?: Array<{
      chainId: number;
      address: string;
    }>;
  } | null;
};

export type ChainsResponse = {
  chains: Array<{
    chainId: number;
    name: string;
    symbol: string;
  }>;
};

export type AppConfigResponse = {
  supportedChains: Array<{
    chainId: number;
    name: string;
    symbol: string;
  }>;
  defaultReceiveTokens: string[];
};

export type SimEvmBalance = {
  chain: string;
  chain_id: number;
  address: string;
  amount: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  price_usd?: number;
  value_usd?: number;
  logo?: string;
  url?: string;
};

export type WalletPortfolioResponse = {
  walletAddress: string;
  totalUsd: number;
  holdings: SimEvmBalance[];
};

export type MarketToken = {
  chain_id: number;
  address: string;
  symbol: string;
  name: string | null;
  decimals: number | null;
  logo_uri: string | null;
  source: string;
  confidence: number;
  updated_at: string;
};

export type TopMarketAsset = {
  id: string;
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  image: string | null;
  current_price: number | null;
  market_cap_rank: number | null;
  market_cap: number | null;
  price_change_percentage_24h: number | null;
  turnover_24h: number | null;
  risk_level: string | null;
};

export type CoinDetail = {
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  currentPriceUsd: number | null;
  holders: number | null;
  totalSupply: number | null;
  liquidityUsd: number | null;
  top10HolderPercent: number | null;
  devHolderPercent: number | null;
  lockLpPercent: number | null;
};

export type KlinePeriod = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export type KlineCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number | null;
};

export type AgentRecommendation = {
  id: string;
  kind: string;
  title: string;
  content: string;
  score?: number;
  created_at: string;
  valid_until?: string;
  source: 'do' | 'd1';
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

export type AgentArticleDetailResponse = {
  article: AgentArticle;
  markdown: string;
};

export type AgentTodayDailyResponse = {
  date: string;
  status: 'ready' | 'generating' | 'failed' | 'stale';
  article: AgentArticle | null;
  lastReadyArticle: AgentArticle | null;
};

export type AgentEventType =
  | 'asset_holding_snapshot'
  | 'asset_viewed'
  | 'asset_favorited'
  | 'trade_buy'
  | 'trade_sell'
  | 'article_read'
  | 'article_favorited'
  | 'page_dwell';

export async function postJson<T>(path: string, body: unknown, withAuth = false): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (withAuth && token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? 'request_failed');
  }

  return data as T;
}

export async function getJson<T>(path: string, withAuth = false): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {};

  if (withAuth && token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? 'request_failed');
  }

  return data as T;
}

export async function getWalletPortfolio(): Promise<WalletPortfolioResponse> {
  return getJson<WalletPortfolioResponse>('/v1/wallet/portfolio', true);
}

export async function getAppConfig(): Promise<AppConfigResponse> {
  return getJson<AppConfigResponse>('/v1/app-config');
}

export async function getMarketTokens(params?: {
  chainId?: number;
  q?: string;
  limit?: number;
}): Promise<{ tokens: MarketToken[] }> {
  const query = new URLSearchParams();
  if (params?.chainId) query.set('chainId', String(params.chainId));
  if (params?.q) query.set('q', params.q);
  if (params?.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return getJson<{ tokens: MarketToken[] }>(`/v1/market/tokens${suffix ? `?${suffix}` : ''}`, true);
}

export async function runMarketTokenIngest(): Promise<{ ok: true; imported: number; sourceCount: number }> {
  return postJson<{ ok: true; imported: number; sourceCount: number }>(
    '/v1/market/tokens/ingest/run',
    {},
    true,
  );
}

export async function getTopMarketAssets(params?: {
  limit?: number;
  name?: 'topGainers' | 'topLosers';
  chains?: string[];
}): Promise<TopMarketAsset[]> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.name) query.set('name', params.name);
  if (params?.chains?.length) query.set('chains', params.chains.join(','));
  const suffix = query.toString();
  const response = await getJson<{ assets: TopMarketAsset[] }>(
    `/v1/market/top-assets${suffix ? `?${suffix}` : ''}`,
    true,
  );
  return response.assets;
}

export async function getCoinDetail(chain: string, contract: string): Promise<CoinDetail> {
  const query = new URLSearchParams();
  query.set('chain', chain);
  query.set('contract', contract);
  const response = await getJson<{ detail: CoinDetail }>(`/v1/market/token-detail?${query.toString()}`, true);
  return response.detail;
}

export async function getTokenKline(
  chain: string,
  contract: string,
  period: KlinePeriod = '1h',
  size = 60,
): Promise<KlineCandle[]> {
  const query = new URLSearchParams();
  query.set('chain', chain);
  query.set('contract', contract);
  query.set('period', period);
  query.set('size', String(size));
  const response = await getJson<{ candles: KlineCandle[] }>(`/v1/market/kline?${query.toString()}`, true);
  return response.candles;
}

export async function getAgentRecommendations(): Promise<{ recommendations: AgentRecommendation[] }> {
  return getJson<{ recommendations: AgentRecommendation[] }>('/v1/agent/recommendations', true);
}

export async function getAgentArticles(params?: {
  type?: 'daily' | 'topic';
  limit?: number;
}): Promise<{ articles: AgentArticle[] }> {
  const query = new URLSearchParams();
  if (params?.type) query.set('type', params.type);
  if (params?.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return getJson<{ articles: AgentArticle[] }>(`/v1/agent/articles${suffix ? `?${suffix}` : ''}`, true);
}

export async function getAgentArticleDetail(articleId: string): Promise<AgentArticleDetailResponse> {
  return getJson<AgentArticleDetailResponse>(`/v1/agent/articles/${articleId}`, true);
}

export async function getAgentTodayDaily(): Promise<AgentTodayDailyResponse> {
  return getJson<AgentTodayDailyResponse>('/v1/agent/daily/today', true);
}

export async function setAgentPreferredLocale(locale: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(
    '/v1/agent/preferences/locale',
    {
      locale,
    },
    true,
  );
}

export async function ingestAgentEvent(
  type: AgentEventType,
  payload?: Record<string, unknown>,
  dedupeKey?: string,
): Promise<{ accepted: boolean; eventId?: string }> {
  return postJson<{ accepted: boolean; eventId?: string }>(
    '/v1/agent/events',
    {
      type,
      payload,
      dedupeKey,
    },
    true,
  );
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
