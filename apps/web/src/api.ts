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
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap_rank: number | null;
  price_change_percentage_24h: number | null;
};

export type CoinDetail = {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  description: string;
  currentPriceUsd: number | null;
  homepage: string | null;
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

export async function getTopMarketAssets(limit = 30): Promise<TopMarketAsset[]> {
  const perPage = Math.min(Math.max(Math.trunc(limit), 1), 250);
  const response = await fetch(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=false&price_change_percentage=24h`,
    {
      headers: { accept: 'application/json' },
    },
  );
  if (!response.ok) {
    throw new Error(`coingecko_top_assets_failed_${response.status}`);
  }
  const rows = (await response.json()) as TopMarketAsset[];
  return rows;
}

type CoinPlatformRow = {
  id: string;
  platforms?: Record<string, string>;
};

type SupportedPlatform = 'ethereum' | 'binance-smart-chain' | 'base';
const NATIVE_COIN_IDS_BY_PLATFORM: Record<SupportedPlatform, string[]> = {
  ethereum: ['ethereum'],
  'binance-smart-chain': ['binancecoin'],
  base: ['ethereum'],
};

let platformIdCache:
  | {
      ts: number;
      byPlatform: Record<SupportedPlatform, Set<string>>;
    }
  | null = null;

const PLATFORM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function getCoinIdsBySupportedPlatforms(): Promise<Record<SupportedPlatform, Set<string>>> {
  const now = Date.now();
  if (platformIdCache && now - platformIdCache.ts < PLATFORM_CACHE_TTL_MS) {
    return platformIdCache.byPlatform;
  }

  const response = await fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=true', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`coingecko_platform_list_failed_${response.status}`);
  }
  const rows = (await response.json()) as CoinPlatformRow[];
  const byPlatform: Record<SupportedPlatform, Set<string>> = {
    ethereum: new Set<string>(),
    'binance-smart-chain': new Set<string>(),
    base: new Set<string>(),
  };

  for (const row of rows) {
    if (!row.id || !row.platforms) continue;
    for (const key of Object.keys(byPlatform) as SupportedPlatform[]) {
      const hasPlatformKey = Object.prototype.hasOwnProperty.call(row.platforms, key);
      if (hasPlatformKey) {
        byPlatform[key].add(row.id);
      }
    }
  }

  for (const key of Object.keys(byPlatform) as SupportedPlatform[]) {
    for (const nativeId of NATIVE_COIN_IDS_BY_PLATFORM[key]) {
      byPlatform[key].add(nativeId);
    }
  }

  platformIdCache = { ts: now, byPlatform };
  return byPlatform;
}

export async function getTopMarketAssetsBySupportedChains(
  limit = 30,
  platforms: SupportedPlatform[] = ['ethereum', 'binance-smart-chain', 'base'],
): Promise<TopMarketAsset[]> {
  const [marketRows, byPlatform] = await Promise.all([
    getTopMarketAssets(250),
    getCoinIdsBySupportedPlatforms(),
  ]);
  const allowedIds = new Set<string>();
  for (const platform of platforms) {
    for (const id of byPlatform[platform]) {
      allowedIds.add(id);
    }
  }
  return marketRows.filter((row) => allowedIds.has(row.id)).slice(0, Math.max(1, Math.trunc(limit)));
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getCoinDetail(coinId: string): Promise<CoinDetail> {
  const response = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`coingecko_coin_detail_failed_${response.status}`);
  }
  const data = (await response.json()) as {
    id?: string;
    symbol?: string;
    name?: string;
    description?: { en?: string };
    image?: { large?: string; small?: string; thumb?: string };
    market_data?: { current_price?: { usd?: number } };
    links?: { homepage?: string[] };
  };
  return {
    id: data.id ?? coinId,
    symbol: (data.symbol ?? '').toUpperCase(),
    name: data.name ?? coinId,
    description: stripHtml(data.description?.en ?? ''),
    image: data.image?.large ?? data.image?.small ?? data.image?.thumb ?? null,
    currentPriceUsd: Number.isFinite(Number(data.market_data?.current_price?.usd))
      ? Number(data.market_data?.current_price?.usd)
      : null,
    homepage: data.links?.homepage?.find((item) => Boolean(item?.trim())) ?? null,
  };
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
