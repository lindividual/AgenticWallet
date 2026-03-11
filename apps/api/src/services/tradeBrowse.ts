import type { Bindings } from '../types';
import { fetchBitgetTopMarketAssets, type MarketTopAsset } from './bitgetWallet';
import { fetchCoinGeckoTopMarketAssets } from './coingecko';
import { fetchBinanceStockTokens, fetchBinanceStockDetail, fetchBinanceStockKlines } from './binance';
import { getSupportedMarketChains } from '../config/appConfig';
import { normalizeMarketChain } from './assetIdentity';
import { loadTokenIconLookup, resolveTokenIconFromLookup } from './marketTopAssets';

export type TradeBrowseMarketItem = {
  id: string;
  asset_id?: string;
  instrument_id?: string;
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
  instrument_id?: string;
  title: string;
  image: string | null;
  probability: number | null;
  volume24h: number | null;
  url: string | null;
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
  yesTokenId: string | null;
  noTokenId: string | null;
  yesProbability: number | null;
  noProbability: number | null;
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
const POLYMARKET_EVENTS_BASE_URL = 'https://gamma-api.polymarket.com/events';
const POLYMARKET_PRICES_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const POLYMARKET_PUBLIC_SEARCH_URL = 'https://gamma-api.polymarket.com/public-search';
const TOKENIZED_STOCK_ICON_CATEGORIES = ['tokenized-stock', 'tokenized-stocks'];
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

let tradeBrowseCache: { expiresAt: number; value: TradeBrowseResponse } | null = null;
let tradeBrowseInFlight: Promise<TradeBrowseResponse> | null = null;
let perpSearchCache: { expiresAt: number; value: TradeBrowseMarketItem[] } | null = null;
let perpSearchInFlight: Promise<TradeBrowseMarketItem[]> | null = null;
let predictionSearchCache: { expiresAt: number; value: TradeBrowsePredictionItem[] } | null = null;
let predictionSearchInFlight: Promise<TradeBrowsePredictionItem[]> | null = null;

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
    instrument_id: asset.instrument_id,
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

async function fetchStocks(env: Bindings): Promise<TradeBrowseMarketItem[]> {
  try {
    const items = (await fetchBinanceStockTokens(15)).slice(0, 10);
    const stockIconLookup = await loadTokenIconLookup(env, {
      source: 'auto',
      name: 'marketCap',
      limit: 200,
      chains: getSupportedMarketChains(),
      categories: TOKENIZED_STOCK_ICON_CATEGORIES,
    });

    return items.map((item) => {
      const normalizedChain = normalizeMarketChain(item.chain);
      const normalizedContract = normalizeText(item.contract);
      const mappedImage = resolveTokenIconFromLookup(
        stockIconLookup,
        {
          symbol: item.stockTicker,
          name: item.name,
          chain: normalizedChain,
          contract: normalizedContract,
        },
      );

      return {
        id: item.id,
        symbol: item.stockTicker,
        name: item.name,
        image: mappedImage ?? item.image,
        chain: normalizedChain || null,
        contract: normalizedContract ?? null,
        currentPrice: item.currentPrice,
        change24h: item.change24h,
        volume24h: item.volume24h,
        source: 'binance' as const,
        metaLabel: item.marketCap ? 'MCap' : null,
        metaValue: item.marketCap,
        externalUrl: `https://www.binance.com/en/alpha/${item.alphaId}`,
      };
    });
  } catch {
    return [];
  }
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
        expiresAt: Date.now() + TRADE_BROWSE_CACHE_TTL_MS,
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
  const events = Array.isArray(row.events) ? row.events : [];
  const primaryEvent = asRecord(events[0]);
  const eventId = normalizeText(primaryEvent?.id);

  return {
    id: `polymarket:${rawId}`,
    title,
    image,
    probability,
    volume24h,
    url: directUrl ?? (slug ? `https://polymarket.com/event/${slug}` : null),
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
  const volume24h =
    toFiniteNumber(eventRow.volume24hr)
    ?? toFiniteNumber(eventRow.volume24h)
    ?? toFiniteNumber(eventRow.oneDayVolume)
    ?? toFiniteNumber(eventRow.volume)
    ?? fallbackItem.volume24h;
  const directUrl = normalizeText(eventRow.url);
  const slug = normalizeText(eventRow.slug);

  return {
    ...fallbackItem,
    title,
    image,
    probability,
    volume24h,
    url: directUrl ?? (slug ? `https://polymarket.com/event/${slug}` : fallbackItem.url),
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
        expiresAt: Date.now() + TRADE_BROWSE_CACHE_TTL_MS,
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

  const detailLookup = new Map<string, Record<string, unknown>>();
  const detailTargetIds = rawEvents
    .map((entry) => normalizeText(entry.id))
    .filter((entry): entry is string => entry != null)
    .slice(0, Math.min(limit, 12));
  if (detailTargetIds.length > 0) {
    const detailRows = await Promise.all(detailTargetIds.map((eventId) => fetchPolymarketEventById(eventId)));
    for (let index = 0; index < detailTargetIds.length; index += 1) {
      const eventId = detailTargetIds[index];
      const detailRow = detailRows[index];
      if (eventId && detailRow) {
        detailLookup.set(eventId, detailRow);
      }
    }
  }

  const output: TradeBrowsePredictionItem[] = [];
  for (const eventRow of rawEvents) {
    const eventId = normalizeText(eventRow.id);
    const enrichedRow = (eventId ? detailLookup.get(eventId) : null) ?? eventRow;
    const parsed = buildPredictionFallbackFromEvent(enrichedRow);
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
    const alphaIdRaw = id.startsWith('binance-stock:') ? id.slice('binance-stock:'.length) : null;
    if (alphaIdRaw) {
      try {
        const detail = await fetchBinanceStockDetail(alphaIdRaw);
        if (detail) {
          const chain = normalizeMarketChain(detail.chain);
          const contract = normalizeContractAddress(detail.contract);
          const stockIconLookup = await loadTokenIconLookup(env, {
            source: 'auto',
            name: 'marketCap',
            limit: 200,
            chains: getSupportedMarketChains(),
            categories: TOKENIZED_STOCK_ICON_CATEGORIES,
          });
          return {
            id: detail.id,
            symbol: detail.stockTicker,
            name: detail.name,
            image: resolveTokenIconFromLookup(
              stockIconLookup,
              {
                symbol: detail.stockTicker,
                name: detail.name,
                chain,
                contract,
              },
            ) ?? detail.image,
            chain: chain || null,
            contract: contract ?? null,
            currentPrice: detail.currentPrice,
            change24h: detail.change24h,
            volume24h: detail.volume24h,
            source: 'binance' as const,
            metaLabel: detail.marketCap ? 'MCap' : null,
            metaValue: detail.marketCap,
            externalUrl: `https://www.binance.com/en/alpha/${detail.alphaId}`,
          };
        }
      } catch { /* fall through to browse list */ }
    }
    const stocks = await fetchStocks(env);
    return stocks.find((item) => item.id === id) ?? null;
  }

  if (options.type === 'perp') {
    const perps = await fetchPerps(env);
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
    const alphaId = options.id.startsWith('binance-stock:')
      ? options.id.slice('binance-stock:'.length)
      : null;
    if (alphaId) {
      try {
        return await fetchBinanceStockKlines(alphaId, period, size);
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
      safeFetch(() => fetchPerps(env).then((items) => items.slice(0, 10)), []),
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
