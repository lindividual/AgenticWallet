import type { Bindings } from '../types';
import { fetchBitgetTopMarketAssets, type MarketTopAsset } from './bitgetWallet';
import { fetchCoinGeckoTopMarketAssets } from './coingecko';
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
  source: 'bitget' | 'coingecko' | 'hyperliquid';
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
  source: 'polymarket';
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
const POLYMARKET_MARKETS_URL = 'https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume&ascending=false&limit=18';
const STOCK_CATEGORY_CANDIDATES = ['tokenized-stock', 'tokenized-stocks'];

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

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
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

async function fetchStocks(env: Bindings): Promise<TradeBrowseMarketItem[]> {
  const chains = getSupportedMarketChains();
  for (const category of STOCK_CATEGORY_CANDIDATES) {
    try {
      const assets = await fetchCoinGeckoTopMarketAssets(env, {
        name: 'marketCap',
        limit: 20,
        chains,
        category,
      });
      const mapped = assets
        .filter((asset) => !isStableLikeAsset(asset))
        .slice(0, 10)
        .map((asset) => mapTopAssetToBrowseItem(asset, 'coingecko'));
      if (mapped.length > 0) {
        return mapped;
      }
    } catch {
      // Continue trying other category aliases.
    }
  }
  return [];
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
    .sort((a, b) => (b.volume24h ?? Number.NEGATIVE_INFINITY) - (a.volume24h ?? Number.NEGATIVE_INFINITY))
    .slice(0, 10);
}

async function fetchPredictions(): Promise<TradeBrowsePredictionItem[]> {
  const response = await fetch(POLYMARKET_MARKETS_URL, {
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

    const rawId = normalizeText(row.id) ?? normalizeText(row.slug) ?? normalizeText(row.conditionId);
    const title = normalizeText(row.question) ?? normalizeText(row.title);
    if (!rawId || !title) continue;

    const image = normalizeText(row.icon) ?? normalizeText(row.image);
    const volume24h =
      toFiniteNumber(row.volume24hr)
      ?? toFiniteNumber(row.volume24h)
      ?? toFiniteNumber(row.oneDayVolume)
      ?? toFiniteNumber(row.volume);

    const outcomePrices = parseNumberArray(row.outcomePrices);
    const probabilityRaw =
      outcomePrices.length > 0
        ? Math.max(...outcomePrices)
        : toFiniteNumber(row.probability) ?? toFiniteNumber(row.lastTradePrice);
    const probability = probabilityRaw == null
      ? null
      : probabilityRaw <= 1
        ? probabilityRaw * 100
        : probabilityRaw;

    const directUrl = normalizeText(row.url);
    const slug = normalizeText(row.slug);

    output.push({
      id: `polymarket:${rawId}`,
      title,
      image,
      probability,
      volume24h,
      url: directUrl ?? (slug ? `https://polymarket.com/event/${slug}` : null),
      source: 'polymarket',
    });
  }

  return output
    .sort((a, b) => (b.volume24h ?? Number.NEGATIVE_INFINITY) - (a.volume24h ?? Number.NEGATIVE_INFINITY))
    .slice(0, 10);
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
      safeFetch(() => fetchPerps(), []),
      safeFetch(() => fetchPredictions(), []),
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
