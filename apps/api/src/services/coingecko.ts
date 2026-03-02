import type { Bindings } from '../types';
import type { MarketTopAsset, TopAssetListName } from './bitgetWallet';
import { buildAssetId, buildChainAssetId } from './assetIdentity';

const DEFAULT_COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';
const DEFAULT_COINGECKO_USER_AGENT = 'AgenticWallet-MVP/0.1 (market-shelves; +https://agentic-wallet.local)';
const MAX_MARKETS_PAGE_SIZE = 250;
const DEFAULT_SUPPORTED_CHAINS: Array<'eth' | 'base' | 'bnb'> = ['eth', 'base', 'bnb'];
const PLATFORM_CACHE_TTL_MS = 10 * 60 * 1000;
const COIN_LIST_CACHE_TTL_MS = 60 * 60 * 1000;
const COIN_LIST_SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000;
const COIN_LIST_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

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

type CoinGeckoCoinListItem = {
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
  name: string | null;
  source: string;
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

const coinPlatformValueCache = new Map<
  string,
  {
    expiresAt: number;
    value: Record<string, string | null | undefined> | undefined;
  }
>();
const coinPlatformPromiseCache = new Map<string, Promise<Record<string, string | null | undefined> | undefined>>();
let coinListPlatformCache:
  | {
      expiresAt: number;
      map: Map<string, Record<string, string | null | undefined>>;
    }
  | null = null;
let coinListPlatformInFlight: Promise<Map<string, Record<string, string | null | undefined>>> | null = null;
let coinListSchemaReady = false;

type CoinListPlatformDbRow = {
  coin_id: string;
  platforms_json: string;
};

type CoinListPlatformMetaRow = {
  last_sync_at: string | null;
  total_rows: number | null;
  changed_rows: number | null;
};

type CoinListPlatformFingerprintRow = {
  coin_id: string;
  symbol: string | null;
  name: string | null;
  platforms_json: string;
};

export type CoinGeckoPlatformSyncResult = {
  ok: true;
  skipped: boolean;
  fetched: number;
  changed: number;
  unchanged: number;
  lastSyncAt: string;
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

function nowIso(): string {
  return new Date().toISOString();
}

function sortPlatformEntries(
  platforms: Record<string, string | null | undefined> | undefined,
): Record<string, string> {
  const entries = Object.entries(platforms ?? {})
    .map(([key, value]) => [key.trim().toLowerCase(), normalizeText(value)?.toLowerCase() ?? ''] as const)
    .filter(([key]) => key.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function parsePlatformsJson(raw: string | null | undefined): Record<string, string | null | undefined> {
  const value = normalizeText(raw);
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, string | null | undefined>;
  } catch {
    return {};
  }
}

function normalizeNameKey(raw: unknown): string {
  const value = normalizeText(raw)?.toLowerCase() ?? '';
  return value.replace(/[^a-z0-9]+/g, '');
}

function normalizeContractAddress(raw: unknown): string | null {
  const value = normalizeText(raw)?.toLowerCase();
  if (!value) return null;
  if (!/^0x[a-f0-9]{40}$/.test(value)) return null;
  return value;
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

function resolveCoinGeckoUserAgent(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  return value || DEFAULT_COINGECKO_USER_AGENT;
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
      const contract = normalizeContractAddress(normalizedPlatforms.ethereum);
      if (contract) return { chain, contract };
    }
    if (chain === 'base') {
      const contract = normalizeContractAddress(normalizedPlatforms.base);
      if (contract) return { chain, contract };
    }
    if (chain === 'bnb') {
      const contract = normalizeContractAddress(
        normalizedPlatforms['binance-smart-chain'] ?? normalizedPlatforms['bnb-smart-chain'],
      );
      if (contract) return { chain, contract };
    }
  }

  return null;
}

function pickNativeChainFallback(
  coinId: string | null,
  symbol: string | null,
  preferredChains: Array<'eth' | 'base' | 'bnb'>,
): ChainMatch | null {
  const id = (coinId ?? '').trim().toLowerCase();
  const sym = (symbol ?? '').trim().toUpperCase();

  const preferred = new Set(preferredChains);
  if (id === 'ethereum' || sym === 'ETH') {
    if (preferred.has('eth')) return { chain: 'eth', contract: '' };
    if (preferred.has('base')) return { chain: 'base', contract: '' };
  }
  if ((id === 'binancecoin' || sym === 'BNB') && preferred.has('bnb')) {
    return { chain: 'bnb', contract: '' };
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
  const sql = `SELECT chain_id, address, symbol, name, source, confidence, updated_at
    FROM token_catalog
    WHERE UPPER(symbol) IN (${symbolPlaceholders})
      AND chain_id IN (${chainPlaceholders})
      AND source = 'portfolio_api'`;

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

  const bySymbol = new Map<string, TokenCatalogRow[]>();
  for (const record of records) {
    const symbol = normalizeText(record.symbol)?.toUpperCase();
    if (!symbol) continue;
    const list = bySymbol.get(symbol);
    if (list) {
      list.push(record);
    } else {
      bySymbol.set(symbol, [record]);
    }
  }

  const chainPriority = new Map(preferredChains.map((chain, index) => [chain, index]));
  const output = new Map<string, ChainMatch>();

  for (const row of rows) {
    const coinId = normalizeText(row.id);
    const symbol = normalizeText(row.symbol)?.toUpperCase();
    if (!coinId || !symbol) continue;

    const candidates = bySymbol.get(symbol) ?? [];
    if (candidates.length === 0) continue;

    const rowNameKey = normalizeNameKey(row.name);
    const strictMatches =
      rowNameKey.length > 0
        ? candidates.filter((candidate) => normalizeNameKey(candidate.name) === rowNameKey)
        : [];

    // If no exact-name match and multiple candidates share this symbol, treat as ambiguous.
    const scopedCandidates =
      strictMatches.length > 0 ? strictMatches : candidates.length === 1 ? candidates : [];
    if (scopedCandidates.length === 0) continue;

    let best: TokenCatalogRow | null = null;
    for (const candidate of scopedCandidates) {
      const chain = CHAIN_ID_TO_CHAIN[candidate.chain_id];
      const address = normalizeText(candidate.address)?.toLowerCase();
      if (!chain || !address) continue;
      if (!best) {
        best = candidate;
        continue;
      }
      const currentPriority = chainPriority.get(chain) ?? Number.MAX_SAFE_INTEGER;
      const bestChain = CHAIN_ID_TO_CHAIN[best.chain_id];
      const bestPriority = bestChain != null ? chainPriority.get(bestChain) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      if (currentPriority < bestPriority) {
        best = candidate;
        continue;
      }
      if (currentPriority > bestPriority) continue;

      const currentConfidence = Number(candidate.confidence ?? 0);
      const bestConfidence = Number(best.confidence ?? 0);
      if (currentConfidence > bestConfidence) {
        best = candidate;
        continue;
      }
      if (currentConfidence < bestConfidence) continue;

      const currentUpdatedAt = normalizeText(candidate.updated_at);
      const bestUpdatedAt = normalizeText(best.updated_at);
      if ((currentUpdatedAt ?? '') > (bestUpdatedAt ?? '')) {
        best = candidate;
      }
    }

    if (!best) continue;
    const chain = CHAIN_ID_TO_CHAIN[best.chain_id];
    const contract = normalizeText(best.address)?.toLowerCase();
    if (!chain || !contract) continue;
    output.set(coinId, { chain, contract });
  }
  return output;
}

async function fetchCoinGeckoJson<T>(env: Bindings, path: string, query?: URLSearchParams): Promise<T> {
  const baseUrl = normalizeBaseUrl(env.COINGECKO_API_BASE_URL);
  const apiKey = env.COINGECKO_API_KEY?.trim() ?? '';
  const userAgent = resolveCoinGeckoUserAgent(env.COINGECKO_USER_AGENT);
  const url = `${baseUrl}${path}${query && query.size > 0 ? `?${query.toString()}` : ''}`;

  const headers = new Headers({
    Accept: 'application/json',
    'User-Agent': userAgent,
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
      'User-Agent': userAgent,
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

async function fetchMarketRows(
  env: Bindings,
  name: TopAssetListName,
  pageSize: number,
  category: string | null,
): Promise<CoinGeckoMarketRow[]> {
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
  if (category) {
    query.set('category', category);
  }

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

async function ensureCoinListPlatformSchema(db: D1Database): Promise<void> {
  if (coinListSchemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS coingecko_coin_platforms (
        coin_id TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        platforms_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS coingecko_coin_platform_sync_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_sync_at TEXT,
        total_rows INTEGER NOT NULL DEFAULT 0,
        changed_rows INTEGER NOT NULL DEFAULT 0
      )`,
    )
    .run();
  coinListSchemaReady = true;
}

async function loadCoinListPlatformMapFromDb(
  db: D1Database,
): Promise<{
  map: Map<string, Record<string, string | null | undefined>>;
  meta: CoinListPlatformMetaRow | null;
}> {
  await ensureCoinListPlatformSchema(db);
  const rows = await db
    .prepare('SELECT coin_id, platforms_json FROM coingecko_coin_platforms')
    .all<CoinListPlatformDbRow>();
  const map = new Map<string, Record<string, string | null | undefined>>();
  for (const row of rows.results ?? []) {
    const coinId = normalizeText(row.coin_id);
    if (!coinId) continue;
    map.set(coinId, parsePlatformsJson(row.platforms_json));
  }
  const meta = await db
    .prepare('SELECT last_sync_at, total_rows, changed_rows FROM coingecko_coin_platform_sync_meta WHERE id = 1 LIMIT 1')
    .first<CoinListPlatformMetaRow>();
  return {
    map,
    meta: meta ?? null,
  };
}

function parseSyncTime(raw: string | null | undefined): number | null {
  const value = normalizeText(raw);
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

export async function syncCoinGeckoCoinListPlatforms(
  env: Bindings,
  options?: { force?: boolean },
): Promise<CoinGeckoPlatformSyncResult> {
  await ensureCoinListPlatformSchema(env.DB);
  const force = options?.force === true;
  const current = await loadCoinListPlatformMapFromDb(env.DB);
  const nowMs = Date.now();
  const lastSyncMs = parseSyncTime(current.meta?.last_sync_at ?? null);

  if (!force && lastSyncMs != null && nowMs - lastSyncMs < COIN_LIST_SYNC_MIN_INTERVAL_MS) {
    return {
      ok: true,
      skipped: true,
      fetched: Number(current.meta?.total_rows ?? current.map.size),
      changed: 0,
      unchanged: Number(current.meta?.total_rows ?? current.map.size),
      lastSyncAt: new Date(lastSyncMs).toISOString(),
    };
  }

  const remoteRows = await fetchCoinGeckoJson<CoinGeckoCoinListItem[]>(
    env,
    '/coins/list',
    new URLSearchParams({ include_platform: 'true' }),
  );

  const existingRows = await env.DB
    .prepare('SELECT coin_id, symbol, name, platforms_json FROM coingecko_coin_platforms')
    .all<CoinListPlatformFingerprintRow>();
  const existingById = new Map<string, CoinListPlatformFingerprintRow>();
  for (const row of existingRows.results ?? []) {
    const coinId = normalizeText(row.coin_id);
    if (!coinId) continue;
    existingById.set(coinId, row);
  }

  const now = nowIso();
  let changed = 0;
  let unchanged = 0;
  const statements: D1PreparedStatement[] = [];

  for (const item of remoteRows) {
    const coinId = normalizeText(item.id);
    if (!coinId) continue;
    const symbol = normalizeText(item.symbol)?.toLowerCase() ?? null;
    const name = normalizeText(item.name);
    const platformsJson = JSON.stringify(sortPlatformEntries(item.platforms));

    const existing = existingById.get(coinId);
    if (
      existing &&
      (normalizeText(existing.symbol)?.toLowerCase() ?? null) === symbol &&
      (normalizeText(existing.name) ?? null) === name &&
      existing.platforms_json === platformsJson
    ) {
      unchanged += 1;
      continue;
    }

    changed += 1;
    statements.push(
      env.DB.prepare(
        `INSERT INTO coingecko_coin_platforms (
          coin_id, symbol, name, platforms_json, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(coin_id) DO UPDATE SET
          symbol = excluded.symbol,
          name = excluded.name,
          platforms_json = excluded.platforms_json,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at`,
      ).bind(coinId, symbol, name, platformsJson, now, now),
    );
  }

  for (let i = 0; i < statements.length; i += 200) {
    await env.DB.batch(statements.slice(i, i + 200));
  }

  await env.DB
    .prepare(
      `INSERT INTO coingecko_coin_platform_sync_meta (id, last_sync_at, total_rows, changed_rows)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_sync_at = excluded.last_sync_at,
         total_rows = excluded.total_rows,
         changed_rows = excluded.changed_rows`,
    )
    .bind(now, remoteRows.length, changed)
    .run();

  // Refresh in-memory map from DB after sync.
  const refreshed = await loadCoinListPlatformMapFromDb(env.DB);
  coinListPlatformCache = {
    expiresAt: Date.now() + COIN_LIST_CACHE_TTL_MS,
    map: refreshed.map,
  };

  return {
    ok: true,
    skipped: false,
    fetched: remoteRows.length,
    changed,
    unchanged,
    lastSyncAt: now,
  };
}

export async function getCoinGeckoCoinListSyncStatus(env: Bindings): Promise<{
  lastSyncAt: string | null;
  totalRows: number;
  changedRows: number;
}> {
  await ensureCoinListPlatformSchema(env.DB);
  const meta = await env.DB
    .prepare('SELECT last_sync_at, total_rows, changed_rows FROM coingecko_coin_platform_sync_meta WHERE id = 1 LIMIT 1')
    .first<CoinListPlatformMetaRow>();
  return {
    lastSyncAt: normalizeText(meta?.last_sync_at) ?? null,
    totalRows: Number(meta?.total_rows ?? 0),
    changedRows: Number(meta?.changed_rows ?? 0),
  };
}

async function fetchCoinPlatforms(
  env: Bindings,
  coinId: string,
): Promise<Record<string, string | null | undefined> | undefined> {
  const now = Date.now();
  const cached = coinPlatformValueCache.get(coinId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inflight = coinPlatformPromiseCache.get(coinId);
  if (inflight) {
    return inflight;
  }

  const query = new URLSearchParams({
    localization: 'false',
    tickers: 'false',
    market_data: 'false',
    community_data: 'false',
    developer_data: 'false',
    sparkline: 'false',
  });
  const task = (async () => {
    const meta = await fetchCoinGeckoJson<CoinGeckoCoinMeta>(env, `/coins/${encodeURIComponent(coinId)}`, query);
    const platforms = meta.platforms;
    coinPlatformValueCache.set(coinId, {
      expiresAt: Date.now() + PLATFORM_CACHE_TTL_MS,
      value: platforms,
    });
    return platforms;
  })()
    .finally(() => {
      coinPlatformPromiseCache.delete(coinId);
    });

  coinPlatformPromiseCache.set(coinId, task);
  return task;
}

async function fetchCoinListPlatformMap(
  env: Bindings,
): Promise<Map<string, Record<string, string | null | undefined>>> {
  const now = Date.now();
  if (coinListPlatformCache && coinListPlatformCache.expiresAt > now) {
    return coinListPlatformCache.map;
  }
  if (coinListPlatformInFlight) {
    return coinListPlatformInFlight;
  }

  coinListPlatformInFlight = (async () => {
    const dbState = await loadCoinListPlatformMapFromDb(env.DB);
    const lastSyncMs = parseSyncTime(dbState.meta?.last_sync_at ?? null);
    const dbFresh =
      dbState.map.size > 0 &&
      lastSyncMs != null &&
      Date.now() - lastSyncMs <= COIN_LIST_STALE_THRESHOLD_MS;

    if (dbFresh) {
      coinListPlatformCache = {
        expiresAt: Date.now() + COIN_LIST_CACHE_TTL_MS,
        map: dbState.map,
      };
      return dbState.map;
    }

    try {
      await syncCoinGeckoCoinListPlatforms(env, { force: false });
    } catch (error) {
      if (dbState.map.size > 0) {
        coinListPlatformCache = {
          expiresAt: Date.now() + COIN_LIST_CACHE_TTL_MS,
          map: dbState.map,
        };
        return dbState.map;
      }
      throw error;
    }

    const refreshed = await loadCoinListPlatformMapFromDb(env.DB);
    coinListPlatformCache = {
      expiresAt: Date.now() + COIN_LIST_CACHE_TTL_MS,
      map: refreshed.map,
    };
    return refreshed.map;
  })().finally(() => {
    coinListPlatformInFlight = null;
  });

  return coinListPlatformInFlight;
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

  const chainAssetId = buildChainAssetId(chainMatch.chain, chainMatch.contract);
  const assetId = buildAssetId(chainMatch.chain, chainMatch.contract, `coingecko:${coinId}`);

  return {
    id: chainAssetId,
    asset_id: assetId,
    chain_asset_id: chainAssetId,
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
    category?: string;
  },
): Promise<MarketTopAsset[]> {
  const listName = options?.name ?? 'topGainers';
  const limit = clampInt(options?.limit ?? 30, 1, 100);
  const preferredChains = normalizeChains(options?.chains);
  const category = normalizeText(options?.category) ?? null;

  const pageSize = clampInt(Math.max(limit * 4, 80), 80, MAX_MARKETS_PAGE_SIZE);
  const rows = sortRowsByRankingName(await fetchMarketRows(env, listName, pageSize, category), listName);
  if (rows.length === 0) return [];

  let coinListPlatformMap = new Map<string, Record<string, string | null | undefined>>();
  try {
    coinListPlatformMap = await fetchCoinListPlatformMap(env);
  } catch {
    coinListPlatformMap = new Map();
  }

  const tokenCatalogMatches = await resolveChainMatchesFromTokenCatalog(env.DB, rows, preferredChains);
  const candidates = rows.slice(0, Math.max(limit * 5, 60));
  const platformCache = new Map<string, Record<string, string | null | undefined> | undefined>();
  const assets: MarketTopAsset[] = [];
  let externalLookupBudget = Math.max(limit * 2, 20);

  for (let start = 0; start < candidates.length && assets.length < limit; start += 8) {
    const batch = candidates.slice(start, start + 8);
    const batchItems = await Promise.all(
      batch.map(async (row, offset) => {
        const coinId = normalizeText(row.id);
        const symbol = normalizeText(row.symbol)?.toUpperCase() ?? null;
        if (coinId) {
          const fromCoinList = pickChainFromPlatforms(coinListPlatformMap.get(coinId), preferredChains);
          if (fromCoinList) {
            return toMarketTopAsset(row, fromCoinList, start + offset);
          }
        }
        if (coinId) {
          const chainFromCatalog = tokenCatalogMatches.get(coinId);
          if (chainFromCatalog) {
            return toMarketTopAsset(row, chainFromCatalog, start + offset);
          }
        }

        const chainFromNative = pickNativeChainFallback(coinId, symbol, preferredChains);
        if (chainFromNative) {
          return toMarketTopAsset(row, chainFromNative, start + offset);
        }

        if (externalLookupBudget <= 0) return null;
        externalLookupBudget -= 1;

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
