const BINANCE_API_BASE = 'https://data-api.binance.vision';
const TICKER_CACHE_TTL_MS = 20_000;
const EXCHANGE_INFO_CACHE_TTL_MS = 300_000;

type BinanceTicker24hr = {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  lastPrice: string;
  volume: string;
  quoteVolume: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  count: number;
};

type BinanceExchangeInfoSymbol = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
};

export type BinanceSpotItem = {
  id: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  currentPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
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

let tickerCache: { expiresAt: number; value: BinanceTicker24hr[] } | null = null;
let tickerInFlight: Promise<BinanceTicker24hr[]> | null = null;
let exchangeInfoCache: { expiresAt: number; value: BinanceExchangeInfoSymbol[] } | null = null;
let exchangeInfoInFlight: Promise<BinanceExchangeInfoSymbol[]> | null = null;

function toFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function fetchTickers(): Promise<BinanceTicker24hr[]> {
  const now = Date.now();
  if (tickerCache && tickerCache.expiresAt > now) return tickerCache.value;
  if (tickerInFlight) return tickerInFlight;

  const task = (async () => {
    const response = await fetch(`${BINANCE_API_BASE}/api/v3/ticker/24hr`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`binance_ticker_http_${response.status}:${detail.slice(0, 200)}`);
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return [];
    const tickers = payload as BinanceTicker24hr[];
    tickerCache = { expiresAt: Date.now() + TICKER_CACHE_TTL_MS, value: tickers };
    return tickers;
  })().finally(() => {
    tickerInFlight = null;
  });

  tickerInFlight = task;
  return task;
}

async function fetchExchangeInfo(): Promise<BinanceExchangeInfoSymbol[]> {
  const now = Date.now();
  if (exchangeInfoCache && exchangeInfoCache.expiresAt > now) return exchangeInfoCache.value;
  if (exchangeInfoInFlight) return exchangeInfoInFlight;

  const task = (async () => {
    const response = await fetch(`${BINANCE_API_BASE}/api/v3/exchangeInfo`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`binance_exchange_info_http_${response.status}:${detail.slice(0, 200)}`);
    }
    const payload = (await response.json()) as { symbols?: BinanceExchangeInfoSymbol[] };
    const symbols = Array.isArray(payload?.symbols) ? payload.symbols : [];
    exchangeInfoCache = { expiresAt: Date.now() + EXCHANGE_INFO_CACHE_TTL_MS, value: symbols };
    return symbols;
  })().finally(() => {
    exchangeInfoInFlight = null;
  });

  exchangeInfoInFlight = task;
  return task;
}

function tickerToBinanceSpotItem(ticker: BinanceTicker24hr, baseAsset: string, quoteAsset: string): BinanceSpotItem {
  return {
    id: `binance:${ticker.symbol}`,
    symbol: baseAsset,
    baseAsset,
    quoteAsset,
    currentPrice: toFiniteNumber(ticker.lastPrice),
    change24h: toFiniteNumber(ticker.priceChangePercent),
    volume24h: toFiniteNumber(ticker.quoteVolume),
    highPrice24h: toFiniteNumber(ticker.highPrice),
    lowPrice24h: toFiniteNumber(ticker.lowPrice),
  };
}

export async function fetchBinanceTopSpotTokens(limit = 20): Promise<BinanceSpotItem[]> {
  const [tickers, exchangeSymbols] = await Promise.all([
    fetchTickers(),
    fetchExchangeInfo(),
  ]);

  const symbolInfoMap = new Map<string, BinanceExchangeInfoSymbol>();
  for (const s of exchangeSymbols) {
    if (s.status === 'TRADING' && s.quoteAsset === 'USDT') {
      symbolInfoMap.set(s.symbol, s);
    }
  }

  const usdtTickers = tickers
    .filter((t) => symbolInfoMap.has(t.symbol))
    .map((t) => {
      const info = symbolInfoMap.get(t.symbol)!;
      return tickerToBinanceSpotItem(t, info.baseAsset, info.quoteAsset);
    })
    .filter((item) => item.volume24h != null && item.volume24h > 0)
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
    .slice(0, limit);

  return usdtTickers;
}

export async function fetchBinanceSpotDetail(binanceSymbol: string): Promise<BinanceSpotItem | null> {
  const [tickers, exchangeSymbols] = await Promise.all([
    fetchTickers(),
    fetchExchangeInfo(),
  ]);

  const symbol = binanceSymbol.toUpperCase();
  const ticker = tickers.find((t) => t.symbol === symbol);
  if (!ticker) return null;

  const info = exchangeSymbols.find((s) => s.symbol === symbol);
  const baseAsset = info?.baseAsset ?? symbol.replace(/USDT$/, '');
  const quoteAsset = info?.quoteAsset ?? 'USDT';

  return tickerToBinanceSpotItem(ticker, baseAsset, quoteAsset);
}

const BINANCE_KLINE_INTERVAL_MAP: Record<string, string> = {
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

export async function fetchBinanceKlines(
  binanceSymbol: string,
  period: string,
  size: number,
): Promise<BinanceKlineCandle[]> {
  const interval = BINANCE_KLINE_INTERVAL_MAP[period] ?? '1h';
  const clampedSize = Math.max(10, Math.min(size, 1000));
  const query = new URLSearchParams({
    symbol: binanceSymbol.toUpperCase(),
    interval,
    limit: String(clampedSize),
  });

  const response = await fetch(`${BINANCE_API_BASE}/api/v3/klines?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`binance_kline_http_${response.status}:${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) return [];

  return payload
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

export async function searchBinanceSpotTokens(
  query: string,
  limit = 20,
): Promise<BinanceSpotItem[]> {
  const normalizedQuery = query.trim().toUpperCase();
  if (!normalizedQuery) return [];

  const [tickers, exchangeSymbols] = await Promise.all([
    fetchTickers(),
    fetchExchangeInfo(),
  ]);

  const tickerMap = new Map<string, BinanceTicker24hr>();
  for (const t of tickers) {
    tickerMap.set(t.symbol, t);
  }

  const matchingSymbols = exchangeSymbols
    .filter((s) => {
      if (s.status !== 'TRADING' || s.quoteAsset !== 'USDT') return false;
      return s.baseAsset.includes(normalizedQuery) || s.symbol.includes(normalizedQuery);
    });

  const results: BinanceSpotItem[] = [];
  for (const info of matchingSymbols) {
    const ticker = tickerMap.get(info.symbol);
    if (!ticker) continue;
    results.push(tickerToBinanceSpotItem(ticker, info.baseAsset, info.quoteAsset));
  }

  return results
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
    .slice(0, limit);
}
