import type { Bindings } from '../types';
import type { MarketTopAsset, TopAssetListName } from './bitgetWallet';

const DEFAULT_COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';
const MAX_MARKETS_PAGE_SIZE = 250;
const DEFAULT_SUPPORTED_CHAINS: Array<'eth' | 'base' | 'bnb'> = ['eth', 'base', 'bnb'];

type CoinGeckoMarketRow = {
  id?: string;
  symbol?: string;
  name?: string;
  image?: string;
  current_price?: number | string;
  market_cap_rank?: number | string;
  market_cap?: number | string;
  price_change_percentage_24h?: number | string;
  total_volume?: number | string;
};

type CoinGeckoTrendingResponse = {
  coins?: Array<{
    item?: {
      id?: string;
    };
  }>;
};

type CoinGeckoCoinMeta = {
  id?: string;
  symbol?: string;
  name?: string;
  platforms?: Record<string, string | null | undefined>;
};

type ChainMatch = {
  chain: 'eth' | 'base' | 'bnb';
  contract: string;
};

type TokenCatalogRow = {
  chain_id: number;
  address: string;
  symbol: string;
  confidence: number | null;
  updated_at: string | null;
};

const CHAIN_TO_CHAIN_ID: Record<ChainMatch['chain'], number> = {
  eth: 1,
  bnb: 56,
  base: 8453,
};

const CHAIN_ID_TO_CHAIN: Record<number, ChainMatch['chain']> = {
  1: 'eth',
  56: 'bnb',
  8453: 'base',
};

function normalizeFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_COINGECKO_BASE_URL;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function normalizeChains(chains?: string[]): Array<'eth' | 'base' | 'bnb'> {
  const normalized = new Set(
    (chains ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter((item): item is 'eth' | 'base' | 'bnb' => item === 'eth' || item === 'base' || item === 'bnb'),
  );
  if (normalized.size === 0) return [...DEFAULT_SUPPORTED_CHAINS];
  return [...normalized];
}

function getOrderByListName(name: TopAssetListName): string {
  if (name === 'topVolume') return 'volume_desc';
  if (name === 'marketCap') return 'market_cap_desc';
  return 'market_cap_desc';
}

function pickChainFromPlatforms(
  platforms: Record<string, string | null | undefined> | undefined,
  preferredChains: Array<'eth' | 'base' | 'bnb'>,
): ChainMatch | null {
  if (!platforms) return null;
  const normalizedPlatforms = Object.fromEntries(
    Object.entries(platforms).map(([key, value]) => [key.trim().toLowerCase(), normalizeText(value) ?? '']),
  );

  for (const chain of preferredChains) {
    if (chain === 'eth') {
      const contract = normalizedPlatforms.ethereum;
      if (typeof contract === 'string') return { chain, contract };
    }
    if (chain === 'base') {
      const contract = normalizedPlatforms.base;
      if (typeof contract === 'string') return { chain, contract };
    }
    if (chain === 'bnb') {
      const contract = normalizedPlatforms['binance-smart-chain'] ?? normalizedPlatforms['bnb-smart-chain'];
      if (typeof contract === 'string') return { chain, contract };
    }
  }

  return null;
}

async function resolveChainMatchesFromTokenCatalog(
  db: D1Database,
  rows: CoinGeckoMarketRow[],
  preferredChains: Array<'eth' | 'base' | 'bnb'>,
): Promise<Map<string, ChainMatch>> {
  const symbols = [
    ...new Set(
      rows
        .map((row) => normalizeText(row.symbol)?.toUpperCase())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (symbols.length === 0) return new Map();

  const chainIds = [...new Set(preferredChains.map((chain) => CHAIN_TO_CHAIN_ID[chain]))];
  if (chainIds.length === 0) return new Map();

  const symbolPlaceholders = symbols.map(() => '?').join(',');
  const chainPlaceholders = chainIds.map(() => '?').join(',');
  const sql = `SELECT chain_id, address, symbol, confidence, updated_at
    FROM token_catalog
    WHERE UPPER(symbol) IN (${symbolPlaceholders})
      AND chain_id IN (${chainPlaceholders})`;

  let records: TokenCatalogRow[] = [];
  try {
    const result = await db
      .prepare(sql)
      .bind(...symbols, ...chainIds)
      .all<TokenCatalogRow>();
    records = result.results ?? [];
  } catch {
    return new Map();
  }

  const chainPriority = new Map(preferredChains.map((chain, index) => [chain, index]));
  const bestBySymbol = new Map<string, TokenCatalogRow>();

  for (const record of records) {
    const symbol = normalizeText(record.symbol)?.toUpperCase();
    const chain = CHAIN_ID_TO_CHAIN[record.chain_id];
    const address = normalizeText(record.address)?.toLowerCase();
    if (!symbol || !chain || !address) continue;

    const existing = bestBySymbol.get(symbol);
    if (!existing) {
      bestBySymbol.set(symbol, record);
      continue;
    }
    const existingChain = CHAIN_ID_TO_CHAIN[existing.chain_id];
    if (!existingChain) {
      bestBySymbol.set(symbol, record);
      continue;
    }
    const currentPriority = chainPriority.get(chain) ?? Number.MAX_SAFE_INTEGER;
    const existingPriority = chainPriority.get(existingChain) ?? Number.MAX_SAFE_INTEGER;
    if (currentPriority < existingPriority) {
      bestBySymbol.set(symbol, record);
      continue;
    }
    if (currentPriority > existingPriority) continue;

    const currentConfidence = Number(record.confidence ?? 0);
    const existingConfidence = Number(existing.confidence ?? 0);
    if (currentConfidence > existingConfidence) {
      bestBySymbol.set(symbol, record);
      continue;
    }
    if (currentConfidence < existingConfidence) continue;

    const currentUpdatedAt = normalizeText(record.updated_at);
    const existingUpdatedAt = normalizeText(existing.updated_at);
    if ((currentUpdatedAt ?? '') > (existingUpdatedAt ?? '')) {
      bestBySymbol.set(symbol, record);
    }
  }

  const output = new Map<string, ChainMatch>();
  for (const [symbol, record] of bestBySymbol.entries()) {
    const chain = CHAIN_ID_TO_CHAIN[record.chain_id];
    const contract = normalizeText(record.address)?.toLowerCase();
    if (!chain || !contract) continue;
    output.set(symbol, { chain, contract });
  }
  return output;
}

async function fetchCoinGeckoJson<T>(env: Bindings, path: string, query?: URLSearchParams): Promise<T> {
  const baseUrl = normalizeBaseUrl(env.COINGECKO_API_BASE_URL);
  const apiKey = env.COINGECKO_API_KEY?.trim() ?? '';
  const url = `${baseUrl}${path}${query && query.size > 0 ? `?${query.toString()}` : ''}`;

  const headers = new Headers({
    Accept: 'application/json',
  });
  if (apiKey) {
    headers.set('x-cg-pro-api-key', apiKey);
  }

  let response = await fetch(url, {
    method: 'GET',
    headers,
  });

  if ((response.status === 401 || response.status === 403) && apiKey) {
    const fallbackHeaders = new Headers({
      Accept: 'application/json',
      'x-cg-demo-api-key': apiKey,
    });
    response = await fetch(url, {
      method: 'GET',
      headers: fallbackHeaders,
    });
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`coingecko_http_${response.status}:${detail.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

async function fetchTrendingMarketRows(env: Bindings): Promise<CoinGeckoMarketRow[]> {
  const trending = await fetchCoinGeckoJson<CoinGeckoTrendingResponse>(env, '/search/trending');
  const ids = (trending.coins ?? [])
    .map((entry) => normalizeText(entry.item?.id))
    .filter((value): value is string => Boolean(value))
    .slice(0, 20);
  if (ids.length === 0) return [];

  const query = new URLSearchParams({
    vs_currency: 'usd',
    ids: ids.join(','),
    sparkline: 'false',
    price_change_percentage: '24h',
  });

  return fetchCoinGeckoJson<CoinGeckoMarketRow[]>(env, '/coins/markets', query);
}

async function fetchMarketRows(env: Bindings, name: TopAssetListName, pageSize: number): Promise<CoinGeckoMarketRow[]> {
  if (name === 'trending') {
    return fetchTrendingMarketRows(env);
  }

  const query = new URLSearchParams({
    vs_currency: 'usd',
    order: getOrderByListName(name),
    per_page: String(pageSize),
    page: '1',
    sparkline: 'false',
    price_change_percentage: '24h',
  });

  return fetchCoinGeckoJson<CoinGeckoMarketRow[]>(env, '/coins/markets', query);
}

function sortRowsByRankingName(rows: CoinGeckoMarketRow[], name: TopAssetListName): CoinGeckoMarketRow[] {
  if (name === 'topGainers') {
    return [...rows].sort((a, b) => {
      const diff =
        (normalizeFiniteNumber(b.price_change_percentage_24h) ?? Number.NEGATIVE_INFINITY) -
        (normalizeFiniteNumber(a.price_change_percentage_24h) ?? Number.NEGATIVE_INFINITY);
      if (diff !== 0) return diff;
      return (normalizeFiniteNumber(a.market_cap_rank) ?? Number.MAX_SAFE_INTEGER) -
        (normalizeFiniteNumber(b.market_cap_rank) ?? Number.MAX_SAFE_INTEGER);
    });
  }
  if (name === 'topLosers') {
    return [...rows].sort((a, b) => {
      const diff =
        (normalizeFiniteNumber(a.price_change_percentage_24h) ?? Number.POSITIVE_INFINITY) -
        (normalizeFiniteNumber(b.price_change_percentage_24h) ?? Number.POSITIVE_INFINITY);
      if (diff !== 0) return diff;
      return (normalizeFiniteNumber(a.market_cap_rank) ?? Number.MAX_SAFE_INTEGER) -
        (normalizeFiniteNumber(b.market_cap_rank) ?? Number.MAX_SAFE_INTEGER);
    });
  }
  if (name === 'topVolume') {
    return [...rows].sort((a, b) => {
      const diff =
        (normalizeFiniteNumber(b.total_volume) ?? Number.NEGATIVE_INFINITY) -
        (normalizeFiniteNumber(a.total_volume) ?? Number.NEGATIVE_INFINITY);
      if (diff !== 0) return diff;
      return (normalizeFiniteNumber(a.market_cap_rank) ?? Number.MAX_SAFE_INTEGER) -
        (normalizeFiniteNumber(b.market_cap_rank) ?? Number.MAX_SAFE_INTEGER);
    });
  }
  if (name === 'marketCap') {
    return [...rows].sort((a, b) => {
      const diff =
        (normalizeFiniteNumber(b.market_cap) ?? Number.NEGATIVE_INFINITY) -
        (normalizeFiniteNumber(a.market_cap) ?? Number.NEGATIVE_INFINITY);
      if (diff !== 0) return diff;
      return (normalizeFiniteNumber(a.market_cap_rank) ?? Number.MAX_SAFE_INTEGER) -
        (normalizeFiniteNumber(b.market_cap_rank) ?? Number.MAX_SAFE_INTEGER);
    });
  }
  return [...rows];
}

async function fetchCoinPlatforms(
  env: Bindings,
  coinId: string,
): Promise<Record<string, string | null | undefined> | undefined> {
  const query = new URLSearchParams({
    localization: 'false',
    tickers: 'false',
    market_data: 'false',
    community_data: 'false',
    developer_data: 'false',
    sparkline: 'false',
  });
  const meta = await fetchCoinGeckoJson<CoinGeckoCoinMeta>(env, `/coins/${encodeURIComponent(coinId)}`, query);
  return meta.platforms;
}

function toMarketTopAsset(
  row: CoinGeckoMarketRow,
  chainMatch: ChainMatch,
  index: number,
): MarketTopAsset | null {
  const coinId = normalizeText(row.id);
  const symbol = normalizeText(row.symbol)?.toUpperCase() ?? null;
  const name = normalizeText(row.name);
  if (!coinId || !symbol || !name) return null;

  return {
    id: `coingecko:${coinId}:${chainMatch.chain}:${chainMatch.contract || 'native'}`,
    chain: chainMatch.chain,
    contract: chainMatch.contract,
    symbol,
    name,
    image: normalizeText(row.image),
    current_price: normalizeFiniteNumber(row.current_price),
    market_cap_rank: normalizeFiniteNumber(row.market_cap_rank) ?? index + 1,
    market_cap: normalizeFiniteNumber(row.market_cap),
    price_change_percentage_24h: normalizeFiniteNumber(row.price_change_percentage_24h),
    turnover_24h: normalizeFiniteNumber(row.total_volume),
    risk_level: null,
  };
}

export async function fetchCoinGeckoTopMarketAssets(
  env: Bindings,
  options?: {
    name?: TopAssetListName;
    limit?: number;
    chains?: string[];
  },
): Promise<MarketTopAsset[]> {
  const listName = options?.name ?? 'topGainers';
  const limit = clampInt(options?.limit ?? 30, 1, 100);
  const preferredChains = normalizeChains(options?.chains);

  const pageSize = clampInt(Math.max(limit * 4, 80), 80, MAX_MARKETS_PAGE_SIZE);
  const rows = sortRowsByRankingName(await fetchMarketRows(env, listName, pageSize), listName);
  if (rows.length === 0) return [];

  const tokenCatalogMatches = await resolveChainMatchesFromTokenCatalog(env.DB, rows, preferredChains);
  const candidates = rows.slice(0, Math.max(limit * 5, 60));
  const platformCache = new Map<string, Record<string, string | null | undefined> | undefined>();
  const assets: MarketTopAsset[] = [];
  let externalLookupBudget = Math.max(limit * 2, 20);

  for (let start = 0; start < candidates.length && assets.length < limit; start += 8) {
    const batch = candidates.slice(start, start + 8);
    const batchItems = await Promise.all(
      batch.map(async (row, offset) => {
        const symbol = normalizeText(row.symbol)?.toUpperCase() ?? null;
        if (symbol) {
          const chainFromCatalog = tokenCatalogMatches.get(symbol);
          if (chainFromCatalog) {
            return toMarketTopAsset(row, chainFromCatalog, start + offset);
          }
        }

        if (externalLookupBudget <= 0) return null;
        externalLookupBudget -= 1;

        const coinId = normalizeText(row.id);
        if (!coinId) return null;
        if (!platformCache.has(coinId)) {
          try {
            const platforms = await fetchCoinPlatforms(env, coinId);
            platformCache.set(coinId, platforms);
          } catch {
            platformCache.set(coinId, undefined);
          }
        }
        const platforms = platformCache.get(coinId);
        const chainMatch = pickChainFromPlatforms(platforms, preferredChains);
        if (!chainMatch) return null;
        return toMarketTopAsset(row, chainMatch, start + offset);
      }),
    );

    for (const item of batchItems) {
      if (!item) continue;
      assets.push(item);
      if (assets.length >= limit) break;
    }
  }

  return assets.slice(0, limit);
}
