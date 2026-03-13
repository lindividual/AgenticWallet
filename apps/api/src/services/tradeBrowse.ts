import type { Bindings } from '../types';
import { fetchBitgetTopMarketAssets, type MarketTopAsset } from './bitgetWallet';
import { fetchCoinGeckoTopMarketAssets } from './coingecko';
import { getSupportedMarketChains } from '../config/appConfig';
import { normalizeMarketChain } from './assetIdentity';
import { loadTokenIconLookup, resolveTokenIconFromLookup } from './marketTopAssets';
import { safeJsonParse } from '../utils/json';

export type TradeBrowseMarketItem = {
  id: string;
  asset_id?: string;
  symbol: string;
  name: string;
  image: string | null;
  chain: string | null;
  contract: string | null;
  currentPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
  source: 'bitget' | 'coingecko' | 'hyperliquid' | 'binance';
  metaLabel: string | null;
  metaValue: number | null;
  externalUrl: string | null;
};

export type TradeBrowsePredictionItem = {
  id: string;
  asset_id?: string;
  title: string;
  image: string | null;
  description: string | null;
  probability: number | null;
  volume24h: number | null;
  url: string | null;
  startDate: string | null;
  endDate: string | null;
  layout: 'binary' | 'winner';
  eventId: string | null;
  outcomeRows: TradeBrowsePredictionOutcomeRow[];
  options: TradeBrowsePredictionOption[];
  source: 'polymarket';
};

export type TradeBrowsePredictionOption = {
  id: string;
  label: string;
  tokenId: string | null;
  probability: number | null;
};

export type TradeBrowsePredictionOutcomeRow = {
  id: string;
  marketId: string;
  label: string;
  volume: number | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  yesProbability: number | null;
  noProbability: number | null;
};

export type TradeMarketDetailType = 'perp' | 'prediction';

export type PredictionEventOutcome = {
  id: string;
  eventId: string | null;
  marketId: string;
  label: string;
  probability: number | null;
  noProbability: number | null;
  volume24h: number | null;
  yesTokenId: string | null;
  noTokenId: string | null;
};

export type PredictionEventDetail = {
  kind: 'prediction_event';
  id: string;
  eventId: string | null;
  title: string;
  image: string | null;
  description: string | null;
  probability: number | null;
  volume24h: number | null;
  url: string | null;
  startDate: string | null;
  endDate: string | null;
  layout: 'binary' | 'winner';
  source: 'polymarket';
  outcomes: PredictionEventOutcome[];
};

export type TradeMarketKlineCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number | null;
};

export type PredictionEventSeries = {
  outcomeId: string;
  label: string;
  tokenId: string | null;
  latestValue: number | null;
  candles: TradeMarketKlineCandle[];
};

export type TradeBrowseResponse = {
  generatedAt: string;
  topMovers: TradeBrowseMarketItem[];
  trendings: TradeBrowseMarketItem[];
  perps: TradeBrowseMarketItem[];
  predictions: TradeBrowsePredictionItem[];
};

type TradeBrowseShelfKey = keyof Omit<TradeBrowseResponse, 'generatedAt'>;
type TradeBrowseShelfValueByKey = {
  topMovers: TradeBrowseMarketItem[];
  trendings: TradeBrowseMarketItem[];
  perps: TradeBrowseMarketItem[];
  predictions: TradeBrowsePredictionItem[];
};
const DEFAULT_TRADE_BROWSE_SHELF_TTL_MS = 20_000;
const TRADE_BROWSE_SHELF_TTL_MS: Record<TradeBrowseShelfKey, number> = {
  topMovers: DEFAULT_TRADE_BROWSE_SHELF_TTL_MS,
  trendings: 12 * 60 * 60 * 1000,
  perps: DEFAULT_TRADE_BROWSE_SHELF_TTL_MS,
  predictions: DEFAULT_TRADE_BROWSE_SHELF_TTL_MS,
};
type TradeBrowseShelfCacheRow = {
  shelf_key: string;
  payload_json: string;
  generated_at: string;
  expires_at: string;
};
type TradeBrowseShelfCacheEntry = {
  generatedAt: string;
  value: unknown;
};
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const POLYMARKET_MARKETS_BASE_URL = 'https://gamma-api.polymarket.com/markets';
const POLYMARKET_EVENTS_BASE_URL = 'https://gamma-api.polymarket.com/events';
const POLYMARKET_PRICES_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const POLYMARKET_PUBLIC_SEARCH_URL = 'https://gamma-api.polymarket.com/public-search';
const STABLECOIN_SYMBOLS = new Set([
  'USDT',
  'USDC',
  'DAI',
  'FDUSD',
  'TUSD',
  'USDE',
  'USDD',
  'USDP',
  'PYUSD',
  'GUSD',
  'FRAX',
  'LUSD',
  'EURC',
  'EURS',
]);

const STABLECOIN_NAME_FRAGMENTS = [
  'stablecoin',
  'usd coin',
  'us dollar',
  'tether',
  'frax',
  'trueusd',
  'paypal usd',
  'pax dollar',
  'gemini dollar',
  'euro coin',
];

const PERP_QUOTE_SUFFIXES = [
  'USDT',
  'USDC',
  'USD',
  'FDUSD',
  'BUSD',
];

const PERP_SYMBOL_ALIASES: Record<string, string[]> = {
  XBT: ['BTC'],
  WBTC: ['BTC'],
  WETH: ['ETH'],
  STETH: ['ETH'],
};

const tradeBrowseShelfValueCache = new Map<TradeBrowseShelfKey, { expiresAt: number; entry: TradeBrowseShelfCacheEntry }>();
const tradeBrowseShelfInFlight = new Map<TradeBrowseShelfKey, Promise<TradeBrowseShelfCacheEntry>>();
let perpSearchCache: { expiresAt: number; value: TradeBrowseMarketItem[] } | null = null;
let perpSearchInFlight: Promise<TradeBrowseMarketItem[]> | null = null;
let predictionSearchCache: { expiresAt: number; value: TradeBrowsePredictionItem[] } | null = null;
let predictionSearchInFlight: Promise<TradeBrowsePredictionItem[]> | null = null;
let predictionSchemaReady = false;
let marketShelfCacheSchemaReady = false;
const PREDICTION_PROJECTION_TTL_MS = 2 * 60 * 1000;

const HYPERLIQUID_INTERVAL_BY_KLINE_PERIOD: Record<string, string> = {
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

const HYPERLIQUID_PERIOD_MS_BY_INTERVAL: Record<string, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

const POLYMARKET_INTERVAL_BY_KLINE_PERIOD: Record<string, string> = {
  '15m': '1h',
  '1h': '6h',
  '4h': '1d',
  '1d': '1w',
  '1w': '1m',
  all: 'max',
};

const POLYMARKET_FIDELITY_BY_KLINE_PERIOD: Record<string, number> = {
  '15m': 5,
  '1h': 15,
  '4h': 60,
  '1d': 240,
  '1w': 1440,
  all: 1440,
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function parseTimestamp(raw: string | null | undefined): number | null {
  const value = normalizeText(raw);
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function isIsoTimestampExpired(raw: string | null | undefined): boolean {
  const ts = parseTimestamp(raw);
  return ts == null || ts <= Date.now();
}

async function ensureMarketShelfCacheSchema(db: D1Database): Promise<void> {
  if (marketShelfCacheSchemaReady) return;
  try {
    await db.prepare('SELECT shelf_key FROM market_shelf_cache LIMIT 1').first();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`market_shelf_cache_schema_missing_run_migrations:${message}`);
  }
  marketShelfCacheSchemaReady = true;
}

async function readTradeBrowseShelfFromD1<K extends TradeBrowseShelfKey>(
  env: Bindings,
  shelfKey: K,
): Promise<{ generatedAt: string; value: TradeBrowseShelfValueByKey[K]; isExpired: boolean } | null> {
  await ensureMarketShelfCacheSchema(env.DB);
  const row = await env.DB
    .prepare(
      `SELECT shelf_key, payload_json, generated_at, expires_at
       FROM market_shelf_cache
       WHERE shelf_key = ?
       LIMIT 1`,
    )
    .bind(shelfKey)
    .first<TradeBrowseShelfCacheRow>();
  if (!row) return null;

  const parsed = safeJsonParse<TradeBrowseShelfValueByKey[K]>(row.payload_json);
  if (!parsed) return null;

  return {
    generatedAt: row.generated_at,
    value: parsed,
    isExpired: isIsoTimestampExpired(row.expires_at),
  };
}

async function writeTradeBrowseShelfToD1<K extends TradeBrowseShelfKey>(
  env: Bindings,
  shelfKey: K,
  value: TradeBrowseShelfValueByKey[K],
  generatedAt: string,
  ttlMs: number,
): Promise<void> {
  await ensureMarketShelfCacheSchema(env.DB);
  const updatedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await env.DB
    .prepare(
      `INSERT INTO market_shelf_cache (shelf_key, payload_json, generated_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(shelf_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         generated_at = excluded.generated_at,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(shelfKey, JSON.stringify(value), generatedAt, expiresAt, updatedAt)
    .run();
}

async function getCachedTradeBrowseShelf<K extends TradeBrowseShelfKey>(
  env: Bindings,
  shelfKey: K,
  ttlMs: number,
  fetcher: () => Promise<TradeBrowseShelfValueByKey[K]>,
): Promise<{ generatedAt: string; value: TradeBrowseShelfValueByKey[K] }> {
  const now = Date.now();
  const memoryCached = tradeBrowseShelfValueCache.get(shelfKey);
  if (memoryCached && memoryCached.expiresAt > now) {
    return {
      generatedAt: memoryCached.entry.generatedAt,
      value: memoryCached.entry.value as TradeBrowseShelfValueByKey[K],
    };
  }

  const inFlight = tradeBrowseShelfInFlight.get(shelfKey);
  if (inFlight) {
    const entry = await inFlight;
    return {
      generatedAt: entry.generatedAt,
      value: entry.value as TradeBrowseShelfValueByKey[K],
    };
  }

  const task = (async () => {
    const d1Cached = await readTradeBrowseShelfFromD1(env, shelfKey).catch(() => null);
    if (d1Cached && !d1Cached.isExpired) {
      const entry: TradeBrowseShelfCacheEntry = {
        generatedAt: d1Cached.generatedAt,
        value: d1Cached.value,
      };
      tradeBrowseShelfValueCache.set(shelfKey, {
        expiresAt: Date.now() + ttlMs,
        entry,
      });
      return entry;
    }

    const value = await fetcher();
    const generatedAt = new Date().toISOString();
    const entry: TradeBrowseShelfCacheEntry = {
      generatedAt,
      value,
    };

    tradeBrowseShelfValueCache.set(shelfKey, {
      expiresAt: Date.now() + ttlMs,
      entry,
    });
    await writeTradeBrowseShelfToD1(env, shelfKey, value, generatedAt, ttlMs).catch(() => undefined);
    return entry;
  })().finally(() => {
    tradeBrowseShelfInFlight.delete(shelfKey);
  });

  tradeBrowseShelfInFlight.set(shelfKey, task);
  const entry = await task;
  return {
    generatedAt: entry.generatedAt,
    value: entry.value as TradeBrowseShelfValueByKey[K],
  };
}

export function normalizeTradeMarketDetailType(value: unknown): TradeMarketDetailType | null {
  const normalized = normalizeText(value)?.toLowerCase();
  if (normalized === 'perp' || normalized === 'prediction') {
    return normalized;
  }
  return null;
}

function toFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function parseNumberArray(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => toFiniteNumber(item)).filter((item): item is number => item != null);
  }
  const text = normalizeText(raw);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((item) => toFiniteNumber(item)).filter((item): item is number => item != null)
      : [];
  } catch {
    return [];
  }
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => normalizeText(item))
      .filter((item): item is string => item != null);
  }
  const text = normalizeText(raw);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed
        .map((item) => normalizeText(item))
        .filter((item): item is string => item != null)
      : [];
  } catch {
    return [];
  }
}

type StoredPredictionEventRow = {
  prediction_event_id: string;
  source: string;
  source_event_id: string | null;
  primary_market_id: string;
  title: string;
  description: string | null;
  image: string | null;
  url: string | null;
  start_date: string | null;
  end_date: string | null;
  layout: 'binary' | 'winner';
  probability: number | null;
  volume24h: number | null;
  synced_at: string | null;
  expires_at: string | null;
};

type StoredPredictionOutcomeRow = {
  source_outcome_id: string;
  source_market_id: string;
  label: string;
  yes_token_id: string | null;
  no_token_id: string | null;
  yes_probability: number | null;
  no_probability: number | null;
  volume24h: number | null;
};

function stripPolymarketPrefix(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return normalized.startsWith('polymarket:') ? normalized.slice('polymarket:'.length) : normalized;
}

function buildPredictionEventStorageId(sourceEventId: string | null, primaryMarketId: string): string {
  return sourceEventId
    ? `pred:event:polymarket:${sourceEventId}`
    : `pred:event:polymarket:market:${primaryMarketId}`;
}

function buildPredictionMarketStorageId(sourceMarketId: string): string {
  return `pred:market:polymarket:${sourceMarketId}`;
}

function buildPredictionOutcomeStorageId(sourceOutcomeId: string): string {
  return `pred:outcome:polymarket:${sourceOutcomeId}`;
}

async function ensurePredictionSchema(db: D1Database): Promise<void> {
  if (predictionSchemaReady) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS prediction_events (
        prediction_event_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_event_id TEXT,
        primary_market_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        image TEXT,
        url TEXT,
        start_date TEXT,
        end_date TEXT,
        layout TEXT NOT NULL,
        probability REAL,
        volume24h REAL,
        raw_json TEXT,
        synced_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_prediction_events_source_event_id ON prediction_events(source_event_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_prediction_events_primary_market_id ON prediction_events(primary_market_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_prediction_events_expires_at ON prediction_events(expires_at)').run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS prediction_markets (
        prediction_market_id TEXT PRIMARY KEY,
        prediction_event_id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_market_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        volume24h REAL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (prediction_event_id) REFERENCES prediction_events(prediction_event_id)
      )`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_prediction_markets_event_id ON prediction_markets(prediction_event_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_prediction_markets_source_market_id ON prediction_markets(source_market_id)').run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS prediction_outcomes (
        prediction_outcome_id TEXT PRIMARY KEY,
        prediction_event_id TEXT NOT NULL,
        prediction_market_id TEXT NOT NULL,
        source_outcome_id TEXT NOT NULL,
        label TEXT NOT NULL,
        yes_token_id TEXT,
        no_token_id TEXT,
        yes_probability REAL,
        no_probability REAL,
        volume24h REAL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (prediction_event_id) REFERENCES prediction_events(prediction_event_id),
        FOREIGN KEY (prediction_market_id) REFERENCES prediction_markets(prediction_market_id)
      )`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_event_id ON prediction_outcomes(prediction_event_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_market_id ON prediction_outcomes(prediction_market_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_yes_token_id ON prediction_outcomes(yes_token_id)').run();

  predictionSchemaReady = true;
}

function clampProbabilityPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function normalizeProbabilityPercent(raw: unknown): number | null {
  const value = toFiniteNumber(raw);
  if (value == null) return null;
  if (value <= 1) return clampProbabilityPercent(value * 100);
  if (value <= 100) return clampProbabilityPercent(value);
  return clampProbabilityPercent(value / 100);
}

function isProjectionExpired(expiresAt: string | null | undefined): boolean {
  const value = normalizeText(expiresAt);
  if (!value) return true;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp <= Date.now();
}

function normalizeTimestampSeconds(raw: unknown): number | null {
  const value = toFiniteNumber(raw);
  if (value == null) return null;
  if (value >= 1e11) return Math.round(value / 1000);
  return Math.round(value);
}

function normalizeContractAddress(raw: unknown): string | null {
  const value = normalizeText(raw)?.toLowerCase();
  if (!value) return null;
  if (!/^0x[a-f0-9]{40}$/.test(value)) return null;
  return value;
}

function normalizePerpUnderlyingSymbol(raw: unknown): string | null {
  let value = normalizeText(raw)?.toUpperCase() ?? null;
  if (!value) return null;
  value = value.replace(/[_\s]+/g, '');
  value = value.replace(/-PERP$/i, '').replace(/PERP$/i, '');

  const slashIndex = value.indexOf('/');
  if (slashIndex > 0) value = value.slice(0, slashIndex);
  const dashIndex = value.indexOf('-');
  if (dashIndex > 0) value = value.slice(0, dashIndex);

  for (const suffix of PERP_QUOTE_SUFFIXES) {
    if (value.endsWith(suffix) && value.length > suffix.length) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  return value || null;
}

function buildPerpIconSymbolCandidates(raw: unknown): string[] {
  const normalized = normalizePerpUnderlyingSymbol(raw);
  if (!normalized) return [];
  const output: string[] = [normalized];
  const aliases = PERP_SYMBOL_ALIASES[normalized] ?? [];
  for (const alias of aliases) {
    if (!output.includes(alias)) output.push(alias);
  }
  return output;
}

function resolvePerpIconFromLookup(
  lookup: Awaited<ReturnType<typeof loadTokenIconLookup>> | null,
  symbol: string,
): string | null {
  if (!lookup) return null;
  const candidates = buildPerpIconSymbolCandidates(symbol);
  for (const candidate of candidates) {
    const icon = resolveTokenIconFromLookup(lookup, {
      symbol: candidate,
      name: candidate,
    });
    if (icon) return icon;
  }
  return null;
}

async function applyCanonicalCryptoItemLogos(
  _env: Bindings,
  items: TradeBrowseMarketItem[],
): Promise<TradeBrowseMarketItem[]> {
  return items;
}

function buildAssetUrl(chain: string, contract: string): string | null {
  const normalizedChain = normalizeText(chain)?.toLowerCase();
  const normalizedContract = normalizeText(contract)?.toLowerCase();
  if (!normalizedChain || !normalizedContract) return null;
  if (normalizedContract === 'native') return null;
  if (!normalizedContract.startsWith('0x')) return null;
  return `https://www.coingecko.com/en/coins/${normalizedChain}/${normalizedContract}`;
}

function isStableLikeAsset(asset: MarketTopAsset): boolean {
  const symbol = (asset.symbol ?? '').trim().toUpperCase();
  if (STABLECOIN_SYMBOLS.has(symbol)) return true;

  const name = (asset.name ?? '').trim().toLowerCase();
  return STABLECOIN_NAME_FRAGMENTS.some((fragment) => name.includes(fragment));
}

function mapTopAssetToBrowseItem(
  asset: MarketTopAsset,
  source: 'bitget' | 'coingecko',
): TradeBrowseMarketItem {
  return {
    id: asset.id,
    asset_id: asset.asset_id,
    symbol: asset.symbol,
    name: asset.name,
    image: asset.image,
    chain: normalizeText(asset.chain),
    contract: normalizeText(asset.contract) ?? '',
    currentPrice: asset.current_price,
    change24h: asset.price_change_percentage_24h,
    volume24h: asset.turnover_24h,
    source,
    metaLabel: null,
    metaValue: null,
    externalUrl: buildAssetUrl(asset.chain, asset.contract),
  };
}

async function fetchTopMovers(env: Bindings): Promise<TradeBrowseMarketItem[]> {
  const chains = getSupportedMarketChains();
  try {
    const assets = await fetchBitgetTopMarketAssets(env, {
      name: 'topGainers',
      limit: 9,
      chains,
    });
    const items = assets
      .filter((asset) => !isStableLikeAsset(asset))
      .slice(0, 9)
      .map((asset) => mapTopAssetToBrowseItem(asset, 'bitget'));
    return applyCanonicalCryptoItemLogos(env, items);
  } catch {
    const fallback = await fetchCoinGeckoTopMarketAssets(env, {
      name: 'topGainers',
      limit: 9,
      chains,
    });
    const items = fallback
      .filter((asset) => !isStableLikeAsset(asset))
      .slice(0, 9)
      .map((asset) => mapTopAssetToBrowseItem(asset, 'coingecko'));
    return applyCanonicalCryptoItemLogos(env, items);
  }
}

async function fetchTrendings(env: Bindings): Promise<TradeBrowseMarketItem[]> {
  const chains = getSupportedMarketChains();
  const assets = await fetchCoinGeckoTopMarketAssets(env, {
    name: 'topVolume',
    limit: 36,
    chains,
  });
  const items = assets
    .filter((asset) => !isStableLikeAsset(asset))
    .slice(0, 16)
    .map((asset) => mapTopAssetToBrowseItem(asset, 'coingecko'));
  return applyCanonicalCryptoItemLogos(env, items);
}

async function fetchPerps(env: Bindings): Promise<TradeBrowseMarketItem[]> {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`hyperliquid_http_${response.status}:${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload) || payload.length < 2) return [];

  const meta = asRecord(payload[0]);
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const ctxs = Array.isArray(payload[1]) ? payload[1] : [];
  const perpIconLookup = await loadTokenIconLookup(env, {
    source: 'auto',
    name: 'marketCap',
    limit: 400,
  }).catch(() => null);
  const output: TradeBrowseMarketItem[] = [];

  const maxLength = Math.min(universe.length, ctxs.length);
  for (let index = 0; index < maxLength; index += 1) {
    const marketMeta = asRecord(universe[index]);
    const marketCtx = asRecord(ctxs[index]);
    if (!marketMeta || !marketCtx) continue;

    const symbol = normalizeText(marketMeta.name)?.toUpperCase();
    if (!symbol) continue;

    const currentPrice = toFiniteNumber(marketCtx.markPx) ?? toFiniteNumber(marketCtx.midPx) ?? toFiniteNumber(marketCtx.oraclePx);
    const previousPrice = toFiniteNumber(marketCtx.prevDayPx);
    const change24h = currentPrice != null && previousPrice != null && previousPrice > 0
      ? ((currentPrice - previousPrice) / previousPrice) * 100
      : null;
    const volume24h = toFiniteNumber(marketCtx.dayNtlVlm);
    const openInterest = toFiniteNumber(marketCtx.openInterest);
    const mappedImage = resolvePerpIconFromLookup(perpIconLookup, symbol);

    output.push({
      id: `hyperliquid:${symbol}`,
      symbol,
      name: `${symbol} Perp`,
      image: mappedImage,
      chain: null,
      contract: null,
      currentPrice,
      change24h,
      volume24h,
      source: 'hyperliquid',
      metaLabel: 'OI',
      metaValue: openInterest,
      externalUrl: `https://app.hyperliquid.xyz/trade/${encodeURIComponent(symbol)}`,
    });
  }

  return output
    .sort((a, b) => (b.volume24h ?? Number.NEGATIVE_INFINITY) - (a.volume24h ?? Number.NEGATIVE_INFINITY));
}

async function getCachedPerps(env: Bindings): Promise<TradeBrowseMarketItem[]> {
  const now = Date.now();
  if (perpSearchCache && perpSearchCache.expiresAt > now) {
    return perpSearchCache.value;
  }
  if (perpSearchInFlight) {
    return perpSearchInFlight;
  }
  const task = fetchPerps(env)
    .then((value) => {
      perpSearchCache = {
        expiresAt: Date.now() + DEFAULT_TRADE_BROWSE_SHELF_TTL_MS,
        value,
      };
      return value;
    })
    .finally(() => {
      perpSearchInFlight = null;
    });
  perpSearchInFlight = task;
  return task;
}

function parsePredictionItemFromRow(row: Record<string, unknown>): TradeBrowsePredictionItem | null {
  const rawId = normalizeText(row.id) ?? normalizeText(row.slug) ?? normalizeText(row.conditionId);
  const title = normalizeText(row.question) ?? normalizeText(row.title);
  if (!rawId || !title) return null;

  const image = normalizeText(row.icon) ?? normalizeText(row.image);
  const description = normalizeText(row.description);
  const volume24h =
    toFiniteNumber(row.volume24hr)
    ?? toFiniteNumber(row.volume24h)
    ?? toFiniteNumber(row.oneDayVolume)
    ?? toFiniteNumber(row.volume);
  const startDate = normalizeText(row.startDate) ?? normalizeText(row.startDateIso);
  const endDate = normalizeText(row.endDate) ?? normalizeText(row.endDateIso);

  const outcomes = parseStringArray(row.outcomes);
  const outcomePrices = parseNumberArray(row.outcomePrices).map((item) => normalizeProbabilityPercent(item)).filter((item): item is number => item != null);
  const clobTokenIds = parseStringArray(row.clobTokenIds);
  const options: TradeBrowsePredictionOption[] = [];
  const optionCount = Math.max(outcomes.length, outcomePrices.length, clobTokenIds.length);
  for (let index = 0; index < optionCount; index += 1) {
    const label = outcomes[index] ?? `Option ${index + 1}`;
    const tokenId = clobTokenIds[index] ?? null;
    const probability = outcomePrices[index] ?? null;
    options.push({
      id: `${rawId}:${index}`,
      label,
      tokenId,
      probability,
    });
  }

  const probability = options
    .map((option) => option.probability)
    .filter((item): item is number => item != null)
    .sort((a, b) => b - a)[0]
    ?? normalizeProbabilityPercent(row.probability)
    ?? normalizeProbabilityPercent(row.lastTradePrice);

  const directUrl = normalizeText(row.url);
  const slug = normalizeText(row.slug);
  const events = Array.isArray(row.events) ? row.events : [];
  const primaryEvent = asRecord(events[0]);
  const eventId = normalizeText(primaryEvent?.id);

  return {
    id: `polymarket:${rawId}`,
    title,
    image,
    description,
    probability,
    volume24h,
    url: directUrl ?? (slug ? `https://polymarket.com/event/${slug}` : null),
    startDate,
    endDate,
    layout: 'binary',
    eventId: eventId ?? null,
    outcomeRows: [],
    options,
    source: 'polymarket',
  };
}

function getBinaryOutcomeIndex(outcomes: string[], side: 'yes' | 'no'): number {
  return outcomes.findIndex((label) => label.trim().toLowerCase() === side);
}

type WinnerOutcomeBuildResult = {
  option: TradeBrowsePredictionOption;
  row: TradeBrowsePredictionOutcomeRow;
};

function buildWinnerOutcomeFromMarket(
  market: Record<string, unknown>,
  eventId: string,
  index: number,
): WinnerOutcomeBuildResult | null {
  const marketId =
    normalizeText(market.id)
    ?? normalizeText(market.slug)
    ?? normalizeText(market.conditionId)
    ?? `${eventId}-${index + 1}`;
  const label =
    normalizeText(market.groupItemTitle)
    ?? normalizeText(market.question)
    ?? normalizeText(market.title)
    ?? `Outcome ${index + 1}`;
  const outcomes = parseStringArray(market.outcomes);
  const yesIndex = getBinaryOutcomeIndex(outcomes, 'yes');
  const noIndex = getBinaryOutcomeIndex(outcomes, 'no');
  if (yesIndex < 0 || noIndex < 0) return null;

  const outcomePrices = parseNumberArray(market.outcomePrices).map((item) => normalizeProbabilityPercent(item));
  const clobTokenIds = parseStringArray(market.clobTokenIds);
  const yesProbability =
    outcomePrices[yesIndex]
    ?? normalizeProbabilityPercent(market.probability)
    ?? normalizeProbabilityPercent(market.lastTradePrice);
  const noProbability = outcomePrices[noIndex] ?? (yesProbability == null ? null : clampProbabilityPercent(100 - yesProbability));
  const volume =
    toFiniteNumber(market.volume24hr)
    ?? toFiniteNumber(market.volume24h)
    ?? toFiniteNumber(market.volume);
  const optionId = `${eventId}:${marketId}`;
  const yesTokenId = clobTokenIds[yesIndex] ?? null;
  const noTokenId = clobTokenIds[noIndex] ?? null;

  return {
    option: {
      id: optionId,
      label,
      tokenId: yesTokenId,
      probability: yesProbability,
    },
    row: {
      id: optionId,
      marketId,
      label,
      volume,
      yesTokenId,
      noTokenId,
      yesProbability,
      noProbability,
    },
  };
}

function marketLikelyTradable(row: Record<string, unknown>): boolean {
  const closed = typeof row.closed === 'boolean' ? row.closed : false;
  const active = typeof row.active === 'boolean' ? row.active : true;
  return active && !closed;
}

async function fetchPolymarketEventById(eventId: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${POLYMARKET_EVENTS_BASE_URL}/${encodeURIComponent(eventId)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    return asRecord(payload);
  } catch {
    return null;
  }
}

function buildWinnerPredictionItemFromEvent(
  eventRow: Record<string, unknown>,
  fallbackItem: TradeBrowsePredictionItem,
): TradeBrowsePredictionItem | null {
  const eventId = normalizeText(eventRow.id);
  if (!eventId) return null;

  const allMarkets = Array.isArray(eventRow.markets)
    ? eventRow.markets.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry != null)
    : [];
  const activeMarkets = allMarkets.filter((entry) => marketLikelyTradable(entry));
  const candidateMarkets = activeMarkets.length >= 2 ? activeMarkets : allMarkets;
  if (candidateMarkets.length < 2) return null;

  const built = candidateMarkets
    .map((market, index) => buildWinnerOutcomeFromMarket(market, eventId, index))
    .filter((entry): entry is WinnerOutcomeBuildResult => entry != null);
  if (built.length < 2) return null;

  const options = built.map((entry) => entry.option);
  const outcomeRows = built.map((entry) => entry.row);
  const title = normalizeText(eventRow.title) ?? fallbackItem.title;
  const knownYesProbabilities = options
    .map((entry) => entry.probability)
    .filter((entry): entry is number => entry != null);
  const summedYesProbability = knownYesProbabilities.reduce((acc, value) => acc + value, 0);
  const probabilityLooksMutuallyExclusive =
    knownYesProbabilities.length >= 2
    && summedYesProbability >= 85
    && summedYesProbability <= 115;
  const titleSuggestsWinner = /\bwinner\b/i.test(title);
  if (!probabilityLooksMutuallyExclusive && !titleSuggestsWinner) return null;

  const probability = options
    .map((entry) => entry.probability)
    .filter((entry): entry is number => entry != null)
    .sort((a, b) => b - a)[0]
    ?? fallbackItem.probability;
  const image = normalizeText(eventRow.icon) ?? normalizeText(eventRow.image) ?? fallbackItem.image;
  const description = normalizeText(eventRow.description) ?? fallbackItem.description;
  const volume24h =
    toFiniteNumber(eventRow.volume24hr)
    ?? toFiniteNumber(eventRow.volume24h)
    ?? toFiniteNumber(eventRow.oneDayVolume)
    ?? toFiniteNumber(eventRow.volume)
    ?? fallbackItem.volume24h;
  const startDate = normalizeText(eventRow.startDate) ?? normalizeText(eventRow.startDateIso) ?? fallbackItem.startDate;
  const endDate = normalizeText(eventRow.endDate) ?? normalizeText(eventRow.endDateIso) ?? fallbackItem.endDate;
  const directUrl = normalizeText(eventRow.url);
  const slug = normalizeText(eventRow.slug);

  return {
    ...fallbackItem,
    title,
    image,
    description,
    probability,
    volume24h,
    url: directUrl ?? (slug ? `https://polymarket.com/event/${slug}` : fallbackItem.url),
    startDate,
    endDate,
    layout: 'winner',
    eventId,
    outcomeRows,
    options,
  };
}

function buildPolymarketMarketsUrl(limit: number): string {
  const query = new URLSearchParams({
    active: 'true',
    closed: 'false',
    order: 'volume',
    ascending: 'false',
    limit: String(Math.max(10, Math.min(limit, 500))),
  });
  return `${POLYMARKET_MARKETS_BASE_URL}?${query.toString()}`;
}

function buildPolymarketPublicSearchUrl(queryText: string, limitPerType: number): string {
  const query = new URLSearchParams({
    q: queryText.trim(),
    limit_per_type: String(Math.max(1, Math.min(limitPerType, 100))),
    search_tags: 'false',
    search_profiles: 'false',
    optimized: 'true',
  });
  return `${POLYMARKET_PUBLIC_SEARCH_URL}?${query.toString()}`;
}

function buildPredictionFallbackFromEvent(
  eventRow: Record<string, unknown>,
): TradeBrowsePredictionItem | null {
  const title = normalizeText(eventRow.title);
  const eventId = normalizeText(eventRow.id);
  const image = normalizeText(eventRow.icon) ?? normalizeText(eventRow.image);
  const directUrl = normalizeText(eventRow.url);
  const slug = normalizeText(eventRow.slug);
  const markets = Array.isArray(eventRow.markets)
    ? eventRow.markets.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry != null)
    : [];
  const activeMarkets = markets.filter((entry) => marketLikelyTradable(entry));
  const primaryMarket = activeMarkets[0] ?? markets[0] ?? null;
  if (!primaryMarket) return null;

  const primaryParsed = parsePredictionItemFromRow({
    ...primaryMarket,
    image,
    icon: image,
    title: title ?? primaryMarket.title,
    slug: slug ?? primaryMarket.slug,
    events: eventId ? [{ id: eventId }] : [],
  });
  if (!primaryParsed) return null;

  const fallbackItem: TradeBrowsePredictionItem = {
    ...primaryParsed,
    title: title ?? primaryParsed.title,
    image: image ?? primaryParsed.image,
    url: directUrl ?? (slug ? `https://polymarket.com/event/${slug}` : primaryParsed.url),
    eventId: eventId ?? primaryParsed.eventId,
  };

  const winnerView = buildWinnerPredictionItemFromEvent(eventRow, fallbackItem);
  return winnerView ?? fallbackItem;
}

async function fetchPredictions(limit = 10): Promise<TradeBrowsePredictionItem[]> {
  const response = await fetch(buildPolymarketMarketsUrl(Math.max(limit * 2, 40)), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`polymarket_http_${response.status}:${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) return [];

  const output: TradeBrowsePredictionItem[] = [];
  for (const entry of payload) {
    const row = asRecord(entry);
    if (!row) continue;
    const parsed = parsePredictionItemFromRow(row);
    if (!parsed) continue;
    output.push(parsed);
  }

  return output
    .sort((a, b) => (b.volume24h ?? Number.NEGATIVE_INFINITY) - (a.volume24h ?? Number.NEGATIVE_INFINITY))
    .slice(0, limit);
}

async function getCachedPredictions(limit = 250): Promise<TradeBrowsePredictionItem[]> {
  const now = Date.now();
  if (predictionSearchCache && predictionSearchCache.expiresAt > now && predictionSearchCache.value.length >= limit) {
    return predictionSearchCache.value.slice(0, limit);
  }
  if (predictionSearchInFlight) {
    const value = await predictionSearchInFlight;
    return value.slice(0, limit);
  }
  const task = fetchPredictions(Math.max(limit, 80))
    .then((value) => {
      predictionSearchCache = {
        expiresAt: Date.now() + DEFAULT_TRADE_BROWSE_SHELF_TTL_MS,
        value,
      };
      return value;
    })
    .finally(() => {
      predictionSearchInFlight = null;
    });
  predictionSearchInFlight = task;
  const value = await task;
  return value.slice(0, limit);
}

function normalizeSearchText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSearchTerms(query: string, extraTerms?: string[]): string[] {
  return [...new Set([query, ...(extraTerms ?? [])]
    .map((item) => normalizeSearchText(item))
    .flatMap((item) => item.split(' '))
    .map((item) => item.trim())
    .filter((item) => item.length >= 2))];
}

export function scoreSearchMatch(text: string, terms: string[]): number {
  const haystack = ` ${normalizeSearchText(text)} `;
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (haystack.includes(` ${term} `)) {
      score += 8;
      continue;
    }
    if (haystack.includes(` ${term}`)) {
      score += 5;
      continue;
    }
    if (haystack.includes(term)) {
      score += 2;
    }
  }
  return score;
}

export async function searchPerpMarkets(
  env: Bindings,
  query: string,
  options?: {
    limit?: number;
    extraTerms?: string[];
  },
): Promise<TradeBrowseMarketItem[]> {
  const terms = buildSearchTerms(query, options?.extraTerms);
  if (!terms.length) return [];
  const perps = await getCachedPerps(env);
  return perps
    .map((item) => ({
      item,
      score: scoreSearchMatch(`${item.symbol} ${item.name}`, terms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Number(b.item.volume24h ?? 0) - Number(a.item.volume24h ?? 0);
    })
    .slice(0, options?.limit ?? 20)
    .map((entry) => entry.item);
}

export async function searchPredictionMarkets(
  query: string,
  options?: {
    limit?: number;
    extraTerms?: string[];
  },
): Promise<TradeBrowsePredictionItem[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const limit = options?.limit ?? 20;
  const response = await fetch(buildPolymarketPublicSearchUrl(normalizedQuery, Math.max(limit, 10)), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`polymarket_search_http_${response.status}:${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as unknown;
  const root = asRecord(payload);
  const rawEvents = Array.isArray(root?.events)
    ? root.events.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry != null)
    : [];
  if (!rawEvents.length) return [];

  const output: TradeBrowsePredictionItem[] = [];
  for (const eventRow of rawEvents) {
    const parsed = buildPredictionFallbackFromEvent(eventRow);
    if (!parsed) continue;
    output.push(parsed);
    if (output.length >= limit) break;
  }

  return output;
}

async function fetchPredictionById(id: string): Promise<TradeBrowsePredictionItem | null> {
  const normalized = normalizeText(id);
  if (!normalized) return null;
  const rawId = normalized.startsWith('polymarket:') ? normalized.slice('polymarket:'.length) : normalized;
  if (!rawId) return null;

  try {
    const response = await fetch(`${POLYMARKET_MARKETS_BASE_URL}/${encodeURIComponent(rawId)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    if (response.ok) {
      const payload = (await response.json()) as unknown;
      const row = asRecord(payload);
      if (row) {
        const parsed = parsePredictionItemFromRow(row);
        if (parsed) {
          if (parsed.eventId) {
            const eventRow = await fetchPolymarketEventById(parsed.eventId);
            if (eventRow) {
              const winnerView = buildWinnerPredictionItemFromEvent(eventRow, parsed);
              if (winnerView) return winnerView;
            }
          }
          return parsed;
        }
      }
    }
  } catch {
    // Fallback to list lookup.
  }

  const eventRow = await fetchPolymarketEventById(rawId);
  if (eventRow) {
    const eventItem = buildPredictionFallbackFromEvent(eventRow);
    if (eventItem) return eventItem;
  }

  const list = await fetchPredictions(240);
  return list.find((item) => item.id === (normalized.startsWith('polymarket:') ? normalized : `polymarket:${rawId}`)) ?? null;
}

export async function fetchTradeMarketDetail(
  env: Bindings,
  options: {
    type: TradeMarketDetailType;
    id: string;
  },
): Promise<TradeBrowseMarketItem | TradeBrowsePredictionItem | null> {
  const id = normalizeText(options.id);
  if (!id) return null;

  if (options.type === 'perp') {
    const perps = await fetchPerps(env);
    return perps.find((item) => item.id === id) ?? null;
  }

  const prediction = await fetchPredictionById(id);
  if (prediction) {
    await upsertPredictionEventProjection(env, prediction);
  }
  return prediction;
}

function normalizeTradeKlinePeriod(value: unknown): string {
  const normalized = normalizeText(value)?.toLowerCase();
  if (normalized === '15m' || normalized === '1h' || normalized === '4h' || normalized === '1d' || normalized === '1w' || normalized === 'all') {
    return normalized;
  }
  return '1h';
}

function sanitizeKlineSize(value: unknown): number {
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) return 60;
  const rounded = Math.round(numberValue);
  if (!Number.isFinite(rounded)) return 60;
  return Math.max(10, Math.min(rounded, 240));
}

function parsePerpSymbolFromId(id: string): string | null {
  const normalized = normalizeText(id);
  if (!normalized) return null;
  if (normalized.startsWith('hyperliquid:')) {
    return normalizeText(normalized.slice('hyperliquid:'.length))?.toUpperCase() ?? null;
  }
  return normalized.toUpperCase();
}

function isPredictionEventDetail(
  item: TradeBrowsePredictionItem | PredictionEventDetail | null | undefined,
): item is PredictionEventDetail {
  return Boolean(item && 'outcomes' in item);
}

function selectPredictionTokenId(
  item: TradeBrowsePredictionItem | PredictionEventDetail | null | undefined,
  preferredTokenId?: string | null,
): string | null {
  const preferred = normalizeText(preferredTokenId);
  const candidates = isPredictionEventDetail(item)
    ? item.outcomes.map((outcome) => outcome.yesTokenId).filter((tokenId): tokenId is string => Boolean(tokenId))
    : (item?.options ?? []).map((option) => option.tokenId).filter((tokenId): tokenId is string => Boolean(tokenId));
  if (preferred && candidates.includes(preferred)) {
    return preferred;
  }

  if (isPredictionEventDetail(item)) {
    const sorted = item.outcomes
      .filter((outcome) => Boolean(outcome.yesTokenId))
      .slice()
      .sort((a, b) => (b.probability ?? Number.NEGATIVE_INFINITY) - (a.probability ?? Number.NEGATIVE_INFINITY));
    return sorted[0]?.yesTokenId ?? null;
  }

  const sorted = (item?.options ?? [])
    .filter((option) => Boolean(option.tokenId))
    .slice()
    .sort((a, b) => (b.probability ?? Number.NEGATIVE_INFINITY) - (a.probability ?? Number.NEGATIVE_INFINITY));
  return sorted[0]?.tokenId ?? null;
}

function toPredictionEventOutcomes(item: TradeBrowsePredictionItem): PredictionEventOutcome[] {
  if (item.layout === 'winner' && item.outcomeRows.length > 0) {
    return item.outcomeRows.map((row) => ({
      id: row.id,
      eventId: item.eventId,
      marketId: row.marketId,
      label: row.label,
      probability: row.yesProbability,
      noProbability: row.noProbability,
      volume24h: row.volume,
      yesTokenId: row.yesTokenId,
      noTokenId: row.noTokenId,
    }));
  }

  const yesOption = item.options.find((option) => option.label.trim().toLowerCase() === 'yes');
  const noOption = item.options.find((option) => option.label.trim().toLowerCase() === 'no');
  return [{
    id: item.id,
    eventId: item.eventId,
    marketId: item.id.replace(/^polymarket:/i, ''),
    label: item.title,
    probability: yesOption?.probability ?? item.probability ?? null,
    noProbability: noOption?.probability ?? null,
    volume24h: item.volume24h,
    yesTokenId: yesOption?.tokenId ?? item.options[0]?.tokenId ?? null,
    noTokenId: noOption?.tokenId ?? item.options[1]?.tokenId ?? null,
  }];
}

export function toPredictionEventDetail(item: TradeBrowsePredictionItem): PredictionEventDetail {
  return {
    kind: 'prediction_event',
    id: item.id,
    eventId: item.eventId,
    title: item.title,
    image: item.image,
    description: item.description,
    probability: item.probability,
    volume24h: item.volume24h,
    url: item.url,
    startDate: item.startDate,
    endDate: item.endDate,
    layout: item.layout,
    source: item.source,
    outcomes: toPredictionEventOutcomes(item),
  };
}

async function upsertPredictionEventProjection(env: Bindings, item: TradeBrowsePredictionItem): Promise<string | null> {
  const primaryMarketId = stripPolymarketPrefix(item.id);
  if (!primaryMarketId) return null;

  await ensurePredictionSchema(env.DB);

  const detail = toPredictionEventDetail(item);
  const sourceEventId = normalizeText(detail.eventId);
  const predictionEventId = buildPredictionEventStorageId(sourceEventId, primaryMarketId);
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PREDICTION_PROJECTION_TTL_MS).toISOString();
  const outcomes = detail.outcomes;
  const marketRows = detail.layout === 'winner'
    ? outcomes.map((outcome, index) => ({
        predictionMarketId: buildPredictionMarketStorageId(outcome.marketId),
        sourceMarketId: outcome.marketId,
        title: outcome.label,
        url: detail.url,
        volume24h: outcome.volume24h,
        sortOrder: index,
      }))
    : [{
        predictionMarketId: buildPredictionMarketStorageId(primaryMarketId),
        sourceMarketId: primaryMarketId,
        title: detail.title,
        url: detail.url,
        volume24h: detail.volume24h,
        sortOrder: 0,
      }];

  const statements = [
    env.DB.prepare(
      `INSERT INTO prediction_events (
        prediction_event_id, source, source_event_id, primary_market_id, title, description, image, url,
        start_date, end_date, layout, probability, volume24h, raw_json, synced_at, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prediction_event_id) DO UPDATE SET
        source = excluded.source,
        source_event_id = excluded.source_event_id,
        primary_market_id = excluded.primary_market_id,
        title = excluded.title,
        description = excluded.description,
        image = excluded.image,
        url = excluded.url,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        layout = excluded.layout,
        probability = excluded.probability,
        volume24h = excluded.volume24h,
        raw_json = excluded.raw_json,
        synced_at = excluded.synced_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`,
    ).bind(
      predictionEventId,
      detail.source,
      sourceEventId,
      primaryMarketId,
      detail.title,
      detail.description,
      detail.image,
      detail.url,
      detail.startDate,
      detail.endDate,
      detail.layout,
      detail.probability,
      detail.volume24h,
      JSON.stringify(detail),
      timestamp,
      expiresAt,
      timestamp,
      timestamp,
    ),
    env.DB.prepare('DELETE FROM prediction_outcomes WHERE prediction_event_id = ?').bind(predictionEventId),
    env.DB.prepare('DELETE FROM prediction_markets WHERE prediction_event_id = ?').bind(predictionEventId),
  ];

  for (const market of marketRows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO prediction_markets (
          prediction_market_id, prediction_event_id, source, source_market_id, title, url, volume24h,
          sort_order, raw_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        market.predictionMarketId,
        predictionEventId,
        detail.source,
        market.sourceMarketId,
        market.title,
        market.url,
        market.volume24h,
        market.sortOrder,
        JSON.stringify(market),
        timestamp,
        timestamp,
      ),
    );
  }

  for (const [index, outcome] of outcomes.entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO prediction_outcomes (
          prediction_outcome_id, prediction_event_id, prediction_market_id, source_outcome_id, label,
          yes_token_id, no_token_id, yes_probability, no_probability, volume24h, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        buildPredictionOutcomeStorageId(outcome.id),
        predictionEventId,
        buildPredictionMarketStorageId(outcome.marketId),
        outcome.id,
        outcome.label,
        outcome.yesTokenId,
        outcome.noTokenId,
        outcome.probability,
        outcome.noProbability,
        outcome.volume24h,
        index,
        timestamp,
        timestamp,
      ),
    );
  }

  await env.DB.batch(statements);
  return predictionEventId;
}

async function readCachedPredictionEventProjection(
  env: Bindings,
  id: string,
): Promise<{ detail: PredictionEventDetail; isExpired: boolean } | null> {
  const normalizedId = normalizeText(id);
  if (!normalizedId) return null;

  await ensurePredictionSchema(env.DB);

  const rawId = stripPolymarketPrefix(normalizedId) ?? normalizedId;
  let eventRow = await env.DB
    .prepare(
      `SELECT prediction_event_id, source, source_event_id, primary_market_id, title, description, image, url,
              start_date, end_date, layout, probability, volume24h, synced_at, expires_at
       FROM prediction_events
       WHERE prediction_event_id = ? OR source_event_id = ? OR primary_market_id = ?
       LIMIT 1`,
    )
    .bind(normalizedId, rawId, rawId)
    .first<StoredPredictionEventRow>();

  if (!eventRow) {
    eventRow = await env.DB
      .prepare(
        `SELECT e.prediction_event_id, e.source, e.source_event_id, e.primary_market_id, e.title, e.description, e.image, e.url,
                e.start_date, e.end_date, e.layout, e.probability, e.volume24h, e.synced_at, e.expires_at
         FROM prediction_events e
         JOIN prediction_markets m ON m.prediction_event_id = e.prediction_event_id
         WHERE m.source_market_id = ?
         LIMIT 1`,
      )
      .bind(rawId)
      .first<StoredPredictionEventRow>();
  }

  if (!eventRow) return null;

  const outcomeRows = await env.DB
    .prepare(
      `SELECT o.source_outcome_id, m.source_market_id, o.label, o.yes_token_id, o.no_token_id,
              o.yes_probability, o.no_probability, o.volume24h
       FROM prediction_outcomes o
       JOIN prediction_markets m ON m.prediction_market_id = o.prediction_market_id
       WHERE o.prediction_event_id = ?
       ORDER BY o.sort_order ASC, m.sort_order ASC`,
    )
    .bind(eventRow.prediction_event_id)
    .all<StoredPredictionOutcomeRow>();

  return {
    isExpired: isProjectionExpired(eventRow.expires_at),
    detail: {
    kind: 'prediction_event',
    id: eventRow.prediction_event_id,
    eventId: eventRow.source_event_id,
    title: eventRow.title,
    image: eventRow.image,
    description: eventRow.description,
    probability: eventRow.probability,
    volume24h: eventRow.volume24h,
    url: eventRow.url,
    startDate: eventRow.start_date,
    endDate: eventRow.end_date,
    layout: eventRow.layout,
    source: 'polymarket',
    outcomes: (outcomeRows.results ?? []).map((row) => ({
      id: row.source_outcome_id,
      eventId: eventRow.source_event_id,
      marketId: row.source_market_id,
      label: row.label,
      probability: row.yes_probability,
      noProbability: row.no_probability,
      volume24h: row.volume24h,
      yesTokenId: row.yes_token_id,
      noTokenId: row.no_token_id,
    })),
    },
  };
}

async function readThroughPredictionEventProjection(env: Bindings, id: string): Promise<PredictionEventDetail | null> {
  const cached = await readCachedPredictionEventProjection(env, id);
  if (cached && !cached.isExpired) return cached.detail;

  const item = await fetchPredictionById(id);
  if (!item) return cached?.detail ?? null;

  const predictionEventId = await upsertPredictionEventProjection(env, item);
  if (!predictionEventId) return toPredictionEventDetail(item);
  const refreshed = await readCachedPredictionEventProjection(env, predictionEventId);
  return refreshed?.detail ?? cached?.detail ?? toPredictionEventDetail(item);
}

async function fetchHyperliquidPerpKlines(
  symbol: string,
  period: string,
  size: number,
): Promise<TradeMarketKlineCandle[]> {
  const interval = HYPERLIQUID_INTERVAL_BY_KLINE_PERIOD[period] ?? '1h';
  const periodMs = HYPERLIQUID_PERIOD_MS_BY_INTERVAL[interval] ?? HYPERLIQUID_PERIOD_MS_BY_INTERVAL['1h'];
  const now = Date.now();
  const endTime = now;
  const startTime = Math.max(0, endTime - (size + 2) * periodMs);

  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: {
        coin: symbol,
        interval,
        startTime,
        endTime,
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`hyperliquid_candle_http_${response.status}:${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    console.warn('[trade-kline-debug][hyperliquid][unexpected_payload]', {
      symbol,
      period,
      size,
      payloadType: typeof payload,
    });
    return [];
  }

  const candles = payload
    .map((entry) => {
      const row = asRecord(entry);
      if (!row) return null;
      const time = normalizeTimestampSeconds(row.t ?? row.T);
      const open = toFiniteNumber(row.o);
      const high = toFiniteNumber(row.h);
      const low = toFiniteNumber(row.l);
      const close = toFiniteNumber(row.c);
      if (time == null || open == null || high == null || low == null || close == null) return null;
      return {
        time,
        open,
        high,
        low,
        close,
        turnover: toFiniteNumber(row.v),
      } satisfies TradeMarketKlineCandle;
    })
    .filter((item): item is TradeMarketKlineCandle => item != null)
    .sort((a, b) => a.time - b.time)
    .slice(-size);
  if (candles.length === 0) {
    console.warn('[trade-kline-debug][hyperliquid][empty]', {
      symbol,
      period,
      size,
      payloadCount: payload.length,
    });
  }
  return candles;
}

async function fetchPolymarketPredictionKlines(
  tokenId: string,
  period: string,
  size: number,
): Promise<TradeMarketKlineCandle[]> {
  const interval = POLYMARKET_INTERVAL_BY_KLINE_PERIOD[period] ?? '1h';
  const fidelity = POLYMARKET_FIDELITY_BY_KLINE_PERIOD[period] ?? 60;
  const query = new URLSearchParams({
    market: tokenId,
    interval,
    fidelity: String(fidelity),
  });
  const response = await fetch(`${POLYMARKET_PRICES_HISTORY_URL}?${query.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`polymarket_prices_history_http_${response.status}:${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as unknown;
  const root = asRecord(payload);
  const history = Array.isArray(root?.history) ? root.history : [];
  if (!history.length) {
    console.warn('[trade-kline-debug][polymarket][empty_history]', {
      tokenId,
      period,
      size,
      interval,
      fidelity,
      rootKeys: root ? Object.keys(root).slice(0, 12) : [],
    });
    return [];
  }

  const points = history
    .map((entry) => {
      const row = asRecord(entry);
      if (!row) return null;
      const time = normalizeTimestampSeconds(row.t);
      const value = normalizeProbabilityPercent(row.p);
      if (time == null || value == null) return null;
      return { time, value };
    })
    .filter((item): item is { time: number; value: number } => item != null)
    .sort((a, b) => a.time - b.time);

  const candles = points.map((point, index) => {
    const previous = points[index - 1] ?? point;
    const open = previous.value;
    const close = point.value;
    return {
      time: point.time,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      turnover: null,
    } satisfies TradeMarketKlineCandle;
  });

  const output = candles.slice(-size);
  if (!output.length) {
    console.warn('[trade-kline-debug][polymarket][empty_output]', {
      tokenId,
      period,
      size,
      points: points.length,
    });
  }
  return output;
}

export async function fetchPredictionEventDetail(env: Bindings, id: string): Promise<PredictionEventDetail | null> {
  return readThroughPredictionEventProjection(env, id);
}

export async function fetchPredictionEventSeries(
  env: Bindings,
  id: string,
  period?: string,
  size?: number,
): Promise<PredictionEventSeries[]> {
  const detail = await readThroughPredictionEventProjection(env, id);
  if (!detail) return [];
  const normalizedPeriod = normalizeTradeKlinePeriod(period);
  const normalizedSize = sanitizeKlineSize(size);

  const series = await Promise.all(detail.outcomes.map(async (outcome) => {
    const tokenId = outcome.yesTokenId;
    if (!tokenId) {
      return {
        outcomeId: outcome.id,
        label: outcome.label,
        tokenId: null,
        latestValue: outcome.probability,
        candles: [],
      } satisfies PredictionEventSeries;
    }

    const candles = await fetchPolymarketPredictionKlines(tokenId, normalizedPeriod, normalizedSize);
    return {
      outcomeId: outcome.id,
      label: outcome.label,
      tokenId,
      latestValue: candles[candles.length - 1]?.close ?? outcome.probability,
      candles,
    } satisfies PredictionEventSeries;
  }));

  return series;
}

export async function fetchTradeMarketKline(
  env: Bindings,
  options: {
    type: TradeMarketDetailType;
    id: string;
    period?: string;
    size?: number;
    optionTokenId?: string | null;
  },
): Promise<TradeMarketKlineCandle[]> {
  const period = normalizeTradeKlinePeriod(options.period);
  const size = sanitizeKlineSize(options.size);

  if (options.type === 'perp') {
    const symbol = parsePerpSymbolFromId(options.id);
    if (!symbol) return [];
    return fetchHyperliquidPerpKlines(symbol, period, size);
  }

  if (options.type === 'prediction') {
    const item = await readThroughPredictionEventProjection(env, options.id);
    const preferred = selectPredictionTokenId(item, options.optionTokenId);
    const candidates = [
      preferred,
      ...(item?.outcomes ?? [])
        .map((outcome) => outcome.yesTokenId)
        .filter((tokenId): tokenId is string => Boolean(tokenId)),
    ].filter((tokenId, index, array): tokenId is string => Boolean(tokenId) && array.indexOf(tokenId) === index);
    for (const tokenId of candidates) {
      const candles = await fetchPolymarketPredictionKlines(tokenId, period, size);
      if (candles.length > 0) return candles;
    }
    console.warn('[trade-kline-debug][prediction][all_candidates_empty]', {
      id: options.id,
      period,
      size,
      preferred,
      candidateCount: candidates.length,
    });
    return [];
  }

  return [];
}

async function safeFetch<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function fetchTradeBrowse(env: Bindings): Promise<TradeBrowseResponse> {
  const [topMovers, trendings, perps, predictions] = await Promise.all([
    getCachedTradeBrowseShelf(
      env,
      'topMovers',
      TRADE_BROWSE_SHELF_TTL_MS.topMovers,
      () => safeFetch(() => fetchTopMovers(env), []),
    ),
    getCachedTradeBrowseShelf(
      env,
      'trendings',
      TRADE_BROWSE_SHELF_TTL_MS.trendings,
      () => safeFetch(() => fetchTrendings(env), []),
    ),
    getCachedTradeBrowseShelf(
      env,
      'perps',
      TRADE_BROWSE_SHELF_TTL_MS.perps,
      () => safeFetch(() => fetchPerps(env).then((items) => items.slice(0, 5)), []),
    ),
    getCachedTradeBrowseShelf(
      env,
      'predictions',
      TRADE_BROWSE_SHELF_TTL_MS.predictions,
      () => safeFetch(() => fetchPredictions(5), []),
    ),
  ]);

  const generatedTimes = [
    topMovers.generatedAt,
    trendings.generatedAt,
    perps.generatedAt,
    predictions.generatedAt,
  ]
    .map((item) => parseTimestamp(item))
    .filter((item): item is number => item != null);

  return {
    generatedAt: generatedTimes.length ? new Date(Math.min(...generatedTimes)).toISOString() : new Date().toISOString(),
    topMovers: topMovers.value,
    trendings: trendings.value,
    perps: perps.value,
    predictions: predictions.value,
  };
}
