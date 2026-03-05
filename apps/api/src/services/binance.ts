const BINANCE_ALPHA_BASE = 'https://www.binance.com';
const BINANCE_DATA_API_BASE = 'https://data-api.binance.vision';
const TOKEN_LIST_CACHE_TTL_MS = 120_000;
const TICKER_CACHE_TTL_MS = 20_000;
const DEFAULT_SPOT_KLINE_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD'];

type BinanceAlphaToken = {
  tokenId: string;
  chainId: string;
  chainName: string;
  contractAddress: string;
  name: string;
  symbol: string;
  iconUrl: string | null;
  price: string;
  percentChange24h: string;
  volume24h: string;
  marketCap: string;
  fdv: string;
  totalSupply: string;
  circulatingSupply: string;
  decimals: number;
  alphaId: string;
  stockState: boolean;
  priceHigh24h: string;
  priceLow24h: string;
  rwaInfo?: {
    openState?: boolean;
    marketStatus?: string;
    metaInfo?: {
      ticker?: string;
    };
    dynamicInfo?: {
      priceHigh52w?: string;
      priceLow52w?: string;
    };
  } | null;
};

export type BinanceStockItem = {
  id: string;
  symbol: string;
  stockTicker: string;
  name: string;
  image: string | null;
  chain: string;
  contract: string;
  chainId: string;
  alphaId: string;
  currentPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
  marketCap: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;
};

export type BinanceKlineCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number | null;
};

let tokenListCache: { expiresAt: number; value: BinanceAlphaToken[] } | null = null;
let tokenListInFlight: Promise<BinanceAlphaToken[]> | null = null;

function toFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeBinanceIconUrl(raw: unknown): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${BINANCE_ALPHA_BASE}${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

async function fetchAlphaTokenList(): Promise<BinanceAlphaToken[]> {
  const now = Date.now();
  if (tokenListCache && tokenListCache.expiresAt > now) return tokenListCache.value;
  if (tokenListInFlight) return tokenListInFlight;

  const task = (async () => {
    const response = await fetch(
      `${BINANCE_ALPHA_BASE}/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list`,
      { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' } },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`binance_alpha_token_list_http_${response.status}:${detail.slice(0, 200)}`);
    }
    const payload = (await response.json()) as { data?: BinanceAlphaToken[] };
    const tokens = Array.isArray(payload?.data) ? payload.data : [];
    tokenListCache = { expiresAt: Date.now() + TOKEN_LIST_CACHE_TTL_MS, value: tokens };
    return tokens;
  })().finally(() => {
    tokenListInFlight = null;
  });

  tokenListInFlight = task;
  return task;
}

function mapAlphaTokenToStockItem(token: BinanceAlphaToken): BinanceStockItem {
  const ticker = token.rwaInfo?.metaInfo?.ticker ?? token.symbol.replace(/on$/i, '');
  return {
    id: `binance-stock:${token.alphaId}`,
    symbol: token.symbol,
    stockTicker: ticker,
    name: token.name.replace(/\s*\(Ondo\)\s*$/i, ''),
    image: normalizeBinanceIconUrl(token.iconUrl),
    chain: token.chainName?.toLowerCase() ?? 'bsc',
    contract: token.contractAddress ?? '',
    chainId: token.chainId ?? '',
    alphaId: token.alphaId,
    currentPrice: toFiniteNumber(token.price),
    change24h: toFiniteNumber(token.percentChange24h),
    volume24h: toFiniteNumber(token.volume24h),
    marketCap: toFiniteNumber(token.marketCap),
    highPrice24h: toFiniteNumber(token.priceHigh24h),
    lowPrice24h: toFiniteNumber(token.priceLow24h),
  };
}

export async function fetchBinanceStockTokens(limit = 20): Promise<BinanceStockItem[]> {
  const allTokens = await fetchAlphaTokenList();
  return allTokens
    .filter((t) => t.stockState === true)
    .sort((a, b) => (toFiniteNumber(b.volume24h) ?? 0) - (toFiniteNumber(a.volume24h) ?? 0))
    .slice(0, limit)
    .map(mapAlphaTokenToStockItem);
}

export async function fetchBinanceStockDetail(alphaId: string): Promise<BinanceStockItem | null> {
  const normalizedId = alphaId.toUpperCase();
  const allTokens = await fetchAlphaTokenList();
  const token = allTokens.find(
    (t) => t.stockState === true && t.alphaId.toUpperCase() === normalizedId,
  );
  if (!token) return null;
  return mapAlphaTokenToStockItem(token);
}

const ALPHA_KLINE_INTERVAL_MAP: Record<string, string> = {
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

const SPOT_KLINE_INTERVAL_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
};

function normalizeSpotBaseSymbol(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  if (!value) return null;
  const cleaned = value.replace(/[^A-Z0-9]/g, '');
  return cleaned || null;
}

function buildSpotPairCandidates(baseSymbol: string, quotes?: string[]): string[] {
  const normalizedBase = normalizeSpotBaseSymbol(baseSymbol);
  if (!normalizedBase) return [];
  const quoteList = (quotes ?? DEFAULT_SPOT_KLINE_QUOTES)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

  for (const quote of quoteList) {
    if (normalizedBase.endsWith(quote) && normalizedBase.length > quote.length) {
      return [normalizedBase];
    }
  }

  return quoteList.map((quote) => `${normalizedBase}${quote}`);
}

function parseBinanceKlineRows(rows: unknown[]): BinanceKlineCandle[] {
  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 6) return null;
      const time = toFiniteNumber(row[0]);
      const open = toFiniteNumber(row[1]);
      const high = toFiniteNumber(row[2]);
      const low = toFiniteNumber(row[3]);
      const close = toFiniteNumber(row[4]);
      if (time == null || open == null || high == null || low == null || close == null) return null;
      const timeSeconds = time >= 1e11 ? Math.round(time / 1000) : Math.round(time);
      return {
        time: timeSeconds,
        open,
        high,
        low,
        close,
        turnover: toFiniteNumber(row[7]),
      } satisfies BinanceKlineCandle;
    })
    .filter((item): item is BinanceKlineCandle => item != null)
    .sort((a, b) => a.time - b.time);
}

async function fetchBinanceSpotKlinesByPair(
  pair: string,
  interval: string,
  limit: number,
): Promise<BinanceKlineCandle[]> {
  const query = new URLSearchParams({
    symbol: pair,
    interval,
    limit: String(limit),
  });
  const response = await fetch(`${BINANCE_DATA_API_BASE}/api/v3/klines?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`binance_spot_kline_http_${response.status}:${detail.slice(0, 200)}`);
  }
  const payload = (await response.json()) as unknown;
  const rows = Array.isArray(payload) ? payload : [];
  return parseBinanceKlineRows(rows);
}

export async function fetchBinanceSpotKlines(
  symbol: string,
  period: string,
  size: number,
): Promise<BinanceKlineCandle[]> {
  const base = normalizeSpotBaseSymbol(symbol);
  if (!base) return [];
  const interval = SPOT_KLINE_INTERVAL_MAP[(period ?? '').trim().toLowerCase()];
  if (!interval) return [];
  const limit = Math.max(10, Math.min(Math.trunc(size || 60), 500));
  const pairs = buildSpotPairCandidates(base);
  for (const pair of pairs) {
    try {
      const candles = await fetchBinanceSpotKlinesByPair(pair, interval, limit);
      if (candles.length > 0) return candles;
    } catch {
      // Try next quote pair.
    }
  }
  return [];
}

export async function fetchBinanceStockKlines(
  alphaId: string,
  period: string,
  size: number,
): Promise<BinanceKlineCandle[]> {
  const interval = ALPHA_KLINE_INTERVAL_MAP[period] ?? '1h';
  const clampedSize = Math.max(10, Math.min(size, 500));
  const symbol = `${alphaId.toUpperCase()}USDT`;
  const query = new URLSearchParams({ symbol, interval, limit: String(clampedSize) });

  const response = await fetch(
    `${BINANCE_ALPHA_BASE}/bapi/defi/v1/public/alpha-trade/klines?${query.toString()}`,
    { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' } },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`binance_alpha_kline_http_${response.status}:${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { data?: unknown[] };
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return parseBinanceKlineRows(rows);
}

export async function searchBinanceTokens(
  query: string,
  limit = 20,
): Promise<BinanceStockItem[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const allTokens = await fetchAlphaTokenList();
  return allTokens
    .filter((t) => {
      if (!t.stockState) return false;
      const sym = t.symbol.toLowerCase();
      const name = t.name.toLowerCase();
      const ticker = t.rwaInfo?.metaInfo?.ticker?.toLowerCase() ?? '';
      return sym.includes(normalizedQuery) || name.includes(normalizedQuery) || ticker.includes(normalizedQuery);
    })
    .sort((a, b) => (toFiniteNumber(b.volume24h) ?? 0) - (toFiniteNumber(a.volume24h) ?? 0))
    .slice(0, limit)
    .map(mapAlphaTokenToStockItem);
}

export async function searchBinanceSpotTokens(
  query: string,
  limit = 20,
): Promise<BinanceStockItem[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const allTokens = await fetchAlphaTokenList();
  return allTokens
    .filter((t) => {
      const sym = t.symbol.toLowerCase();
      const name = t.name.toLowerCase();
      return sym.includes(normalizedQuery) || name.includes(normalizedQuery);
    })
    .sort((a, b) => (toFiniteNumber(b.volume24h) ?? 0) - (toFiniteNumber(a.volume24h) ?? 0))
    .slice(0, limit)
    .map((t) => {
      const item = mapAlphaTokenToStockItem(t);
      return { ...item, id: `binance-alpha:${t.alphaId}` };
    });
}
