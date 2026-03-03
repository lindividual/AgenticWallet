import type { Bindings } from '../types';
import { fetchBitgetTopMarketAssets, type MarketTopAsset } from './bitgetWallet';
import { fetchCoinGeckoTopMarketAssets } from './coingecko';
import { fetchBinanceTopSpotTokens, fetchBinanceSpotDetail, fetchBinanceKlines } from './binance';
import { getSupportedMarketChains } from '../config/appConfig';

export type TradeBrowseMarketItem = {
  id: string;
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
  title: string;
  image: string | null;
  probability: number | null;
  volume24h: number | null;
  url: string | null;
  options: TradeBrowsePredictionOption[];
  source: 'polymarket';
};

export type TradeBrowsePredictionOption = {
  id: string;
  label: string;
  tokenId: string | null;
  probability: number | null;
};

export type TradeMarketDetailType = 'stock' | 'perp' | 'prediction';

export type TradeMarketKlineCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number | null;
};

export type TradeBrowseResponse = {
  generatedAt: string;
  topMovers: TradeBrowseMarketItem[];
  trendings: TradeBrowseMarketItem[];
  stocks: TradeBrowseMarketItem[];
  perps: TradeBrowseMarketItem[];
  predictions: TradeBrowsePredictionItem[];
};

const TRADE_BROWSE_CACHE_TTL_MS = 20_000;
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const POLYMARKET_MARKETS_BASE_URL = 'https://gamma-api.polymarket.com/markets';
const POLYMARKET_PRICES_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const STOCK_CATEGORY_CANDIDATES = ['tokenized-stock', 'tokenized-stocks'];
const ONDO_STOCK_NAME_HINTS = ['ondo', 'global markets', 'omf'];

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

let tradeBrowseCache: { expiresAt: number; value: TradeBrowseResponse } | null = null;
let tradeBrowseInFlight: Promise<TradeBrowseResponse> | null = null;

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
  '1h': '1h',
  '4h': '6h',
  '1d': '1d',
};

const POLYMARKET_FIDELITY_BY_KLINE_PERIOD: Record<string, number> = {
  '15m': 30,
  '1h': 60,
  '4h': 120,
  '1d': 240,
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

export function normalizeTradeMarketDetailType(value: unknown): TradeMarketDetailType | null {
  const normalized = normalizeText(value)?.toLowerCase();
  if (normalized === 'stock' || normalized === 'perp' || normalized === 'prediction') {
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

function normalizeTimestampSeconds(raw: unknown): number | null {
  const value = toFiniteNumber(raw);
  if (value == null) return null;
  if (value >= 1e11) return Math.round(value / 1000);
  return Math.round(value);
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
    symbol: asset.symbol,
    name: asset.name,
    image: asset.image,
    chain: normalizeText(asset.chain),
    contract: normalizeText(asset.contract),
    currentPrice: asset.current_price,
    change24h: asset.price_change_percentage_24h,
    volume24h: asset.turnover_24h,
    source,
    metaLabel: null,
    metaValue: null,
    externalUrl: buildAssetUrl(asset.chain, asset.contract),
  };
}

function sanitizeCompanyName(raw: string): string {
  const stripped = raw
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || raw.trim();
}

function isOndoStockAsset(asset: MarketTopAsset): boolean {
  const assetId = (asset.asset_id ?? '').trim().toLowerCase();
  const name = (asset.name ?? '').trim().toLowerCase();
  const symbol = (asset.symbol ?? '').trim().toLowerCase();
  if (!assetId && !name && !symbol) return false;
  return ONDO_STOCK_NAME_HINTS.some(
    (hint) => assetId.includes(hint) || name.includes(hint) || symbol.includes(hint),
  );
}

async function fetchTopMovers(env: Bindings): Promise<TradeBrowseMarketItem[]> {
  const chains = getSupportedMarketChains();
  try {
    const assets = await fetchBitgetTopMarketAssets(env, {
      name: 'topGainers',
      limit: 9,
      chains,
    });
    return assets
      .filter((asset) => !isStableLikeAsset(asset))
      .slice(0, 9)
      .map((asset) => mapTopAssetToBrowseItem(asset, 'bitget'));
  } catch {
    const fallback = await fetchCoinGeckoTopMarketAssets(env, {
      name: 'topGainers',
      limit: 9,
      chains,
    });
    return fallback
      .filter((asset) => !isStableLikeAsset(asset))
      .slice(0, 9)
      .map((asset) => mapTopAssetToBrowseItem(asset, 'coingecko'));
  }
}

async function fetchTrendings(env: Bindings): Promise<TradeBrowseMarketItem[]> {
  const chains = getSupportedMarketChains();
  const assets = await fetchCoinGeckoTopMarketAssets(env, {
    name: 'topVolume',
    limit: 36,
    chains,
  });
  return assets
    .filter((asset) => !isStableLikeAsset(asset))
    .slice(0, 16)
    .map((asset) => mapTopAssetToBrowseItem(asset, 'coingecko'));
}

async function fetchStocks(_env: Bindings): Promise<TradeBrowseMarketItem[]> {
  try {
    const items = await fetchBinanceTopSpotTokens(15);
    return items
      .filter((item) => !STABLECOIN_SYMBOLS.has(item.baseAsset.toUpperCase()))
      .slice(0, 10)
      .map((item) => ({
        id: item.id,
        symbol: item.baseAsset,
        name: `${item.baseAsset}/${item.quoteAsset}`,
        image: null,
        chain: null,
        contract: null,
        currentPrice: item.currentPrice,
        change24h: item.change24h,
        volume24h: item.volume24h,
        source: 'binance' as const,
        metaLabel: null,
        metaValue: null,
        externalUrl: `https://www.binance.com/trade/${item.baseAsset}_${item.quoteAsset}`,
      }));
  } catch {
    return [];
  }
}

async function fetchPerps(): Promise<TradeBrowseMarketItem[]> {
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

    output.push({
      id: `hyperliquid:${symbol}`,
      symbol,
      name: `${symbol} Perp`,
      image: null,
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

function parsePredictionItemFromRow(row: Record<string, unknown>): TradeBrowsePredictionItem | null {
  const rawId = normalizeText(row.id) ?? normalizeText(row.slug) ?? normalizeText(row.conditionId);
  const title = normalizeText(row.question) ?? normalizeText(row.title);
  if (!rawId || !title) return null;

  const image = normalizeText(row.icon) ?? normalizeText(row.image);
  const volume24h =
    toFiniteNumber(row.volume24hr)
    ?? toFiniteNumber(row.volume24h)
    ?? toFiniteNumber(row.oneDayVolume)
    ?? toFiniteNumber(row.volume);

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

  return {
    id: `polymarket:${rawId}`,
    title,
    image,
    probability,
    volume24h,
    url: directUrl ?? (slug ? `https://polymarket.com/event/${slug}` : null),
    options,
    source: 'polymarket',
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
        if (parsed) return parsed;
      }
    }
  } catch {
    // Fallback to list lookup.
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

  if (options.type === 'stock') {
    const rawId = id.startsWith('binance:') ? id.slice('binance:'.length) : id;
    if (rawId) {
      try {
        const detail = await fetchBinanceSpotDetail(rawId);
        if (detail) {
          return {
            id: detail.id,
            symbol: detail.baseAsset,
            name: `${detail.baseAsset}/${detail.quoteAsset}`,
            image: null,
            chain: null,
            contract: null,
            currentPrice: detail.currentPrice,
            change24h: detail.change24h,
            volume24h: detail.volume24h,
            source: 'binance' as const,
            metaLabel: null,
            metaValue: null,
            externalUrl: `https://www.binance.com/trade/${detail.baseAsset}_${detail.quoteAsset}`,
          };
        }
      } catch { /* fall through to browse list */ }
    }
    const stocks = await fetchStocks(env);
    return stocks.find((item) => item.id === id) ?? null;
  }

  if (options.type === 'perp') {
    const perps = await fetchPerps();
    return perps.find((item) => item.id === id) ?? null;
  }

  return fetchPredictionById(id);
}

function normalizeTradeKlinePeriod(value: unknown): string {
  const normalized = normalizeText(value)?.toLowerCase();
  if (normalized === '15m' || normalized === '1h' || normalized === '4h' || normalized === '1d') {
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

function selectPredictionTokenId(
  item: TradeBrowsePredictionItem | null | undefined,
  preferredTokenId?: string | null,
): string | null {
  const preferred = normalizeText(preferredTokenId);
  if (preferred && item?.options.some((option) => option.tokenId === preferred)) {
    return preferred;
  }

  const sorted = (item?.options ?? [])
    .filter((option) => Boolean(option.tokenId))
    .slice()
    .sort((a, b) => (b.probability ?? Number.NEGATIVE_INFINITY) - (a.probability ?? Number.NEGATIVE_INFINITY));
  return sorted[0]?.tokenId ?? null;
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

  if (options.type === 'stock') {
    const rawId = options.id.startsWith('binance:') ? options.id.slice('binance:'.length) : options.id;
    if (rawId) {
      try {
        return await fetchBinanceKlines(rawId, period, size);
      } catch {
        return [];
      }
    }
    return [];
  }

  if (options.type === 'perp') {
    const symbol = parsePerpSymbolFromId(options.id);
    if (!symbol) return [];
    return fetchHyperliquidPerpKlines(symbol, period, size);
  }

  if (options.type === 'prediction') {
    const item = await fetchPredictionById(options.id);
    const preferred = selectPredictionTokenId(item, options.optionTokenId);
    const candidates = [
      preferred,
      ...(item?.options ?? [])
        .map((option) => option.tokenId)
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
  const now = Date.now();
  if (tradeBrowseCache && tradeBrowseCache.expiresAt > now) {
    return tradeBrowseCache.value;
  }

  if (tradeBrowseInFlight) {
    return tradeBrowseInFlight;
  }

  const task = (async () => {
    const [topMovers, trendings, stocks, perps, predictions] = await Promise.all([
      safeFetch(() => fetchTopMovers(env), []),
      safeFetch(() => fetchTrendings(env), []),
      safeFetch(() => fetchStocks(env), []),
      safeFetch(() => fetchPerps().then((items) => items.slice(0, 10)), []),
      safeFetch(() => fetchPredictions(10), []),
    ]);

    const value: TradeBrowseResponse = {
      generatedAt: new Date().toISOString(),
      topMovers,
      trendings,
      stocks,
      perps,
      predictions,
    };

    tradeBrowseCache = {
      expiresAt: Date.now() + TRADE_BROWSE_CACHE_TTL_MS,
      value,
    };

    return value;
  })().finally(() => {
    tradeBrowseInFlight = null;
  });

  tradeBrowseInFlight = task;
  return task;
}
