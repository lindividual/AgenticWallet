const BINANCE_WEB3_BASE = 'https://web3.binance.com';
const BINANCE_STATIC_BASE = 'https://bin.bnbstatic.com';
const BINANCE_DATA_API_BASE = 'https://data-api.binance.vision';
const TICKER_CACHE_TTL_MS = 20_000;
const DEFAULT_SPOT_KLINE_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD'];
const BINANCE_WEB3_SEARCH_URL = `${BINANCE_WEB3_BASE}/bapi/defi/v5/public/wallet-direct/buw/wallet/market/token/search`;
const BINANCE_WEB3_TOKEN_META_URL = `${BINANCE_WEB3_BASE}/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/meta/info`;
const BINANCE_WEB3_TOKEN_DYNAMIC_URL = `${BINANCE_WEB3_BASE}/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info`;
const BINANCE_WEB3_KLINE_URL = 'https://dquery.sintral.io/u-kline/v1/k-line/candles';
const BINANCE_WEB3_NATIVE_CONTRACT_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const BINANCE_CHAIN_ID_TO_MARKET_CHAIN: Record<string, string> = {
  CT_0: 'btc',
  '1': 'eth',
  '56': 'bnb',
  '8453': 'base',
  '42161': 'arbitrum',
  '10': 'optimism',
  '137': 'matic',
  CT_195: 'tron',
  CT_501: 'sol',
};
const MARKET_CHAIN_TO_BINANCE_CHAIN_ID: Record<string, string> = {
  btc: 'CT_0',
  eth: '1',
  bnb: '56',
  base: '8453',
  arbitrum: '42161',
  optimism: '10',
  matic: '137',
  tron: 'CT_195',
  sol: 'CT_501',
};
const MARKET_CHAIN_TO_BINANCE_KLINE_PLATFORM: Record<string, string> = {
  eth: 'eth',
  bnb: 'bsc',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  matic: 'polygon',
  sol: 'solana',
};
const BINANCE_WEB3_WRAPPED_NATIVE_CONTRACTS: Record<string, string> = {
  eth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  bnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  base: '0x4200000000000000000000000000000000000006',
  sol: 'So11111111111111111111111111111111111111112',
};

type BinanceWeb3TokenAddress = {
  chainId?: string;
  contractAddress?: string;
  nativeAddressFlag?: boolean;
  decimals?: number;
};

type BinanceWeb3SearchToken = {
  tokenId?: string;
  chainId?: string;
  contractAddress?: string;
  name?: string;
  symbol?: string;
  icon?: string | null;
  price?: string;
  percentChange24h?: string;
  volume24h?: string;
  marketCap?: string;
  tokenAddresses?: BinanceWeb3TokenAddress[];
};

export type BinanceSpotSearchItem = {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  chain: string;
  contract: string;
  currentPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
  marketCap: number | null;
  nativeAddressFlag: boolean;
};

export type BinanceKlineCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number | null;
};

export type BinanceTokenMeta = {
  tokenId: string | null;
  name: string | null;
  symbol: string | null;
  chainId: string | null;
  chainName: string | null;
  contractAddress: string | null;
  decimals: number | null;
  icon: string | null;
  nativeAddressFlag: boolean;
  lsdFlag: number | null;
  aiNarrativeFlag: number | null;
  links: Array<{ label: string; link: string }>;
  previewLink: {
    website: string[];
    x: string[];
    tg: string[];
  } | null;
  tokenAddresses: Array<{
    chainId: string | null;
    contractAddress: string | null;
    nativeAddressFlag: boolean;
    lsdFlag: number | null;
    decimals: number | null;
  }>;
  createTime: number | null;
  creatorAddress: string | null;
  auditInfo: {
    isBlacklist: boolean;
    isWhitelist: boolean;
  } | null;
  description: string | null;
  rwaType: number | null;
};

export type BinanceTokenDynamicInfo = {
  price: number | null;
  nativeTokenPrice: number | null;
  volume24h: number | null;
  volume24hBuy: number | null;
  volume24hSell: number | null;
  volume4h: number | null;
  volume1h: number | null;
  volume5m: number | null;
  count24h: number | null;
  count24hBuy: number | null;
  count24hSell: number | null;
  percentChange5m: number | null;
  percentChange1h: number | null;
  percentChange4h: number | null;
  percentChange24h: number | null;
  marketCap: number | null;
  totalSupply: number | null;
  circulatingSupply: number | null;
  priceHigh24h: number | null;
  priceLow24h: number | null;
  holders: number | null;
  fdv: number | null;
  liquidity: number | null;
  launchTime: number | null;
  top10HoldersPercentage: number | null;
  kycHolderCount: number | null;
  kolHolders: number | null;
  kolHoldingPercent: number | null;
  proHolders: number | null;
  proHoldingPercent: number | null;
  newWalletHolders: number | null;
  newWalletHoldingPercent: number | null;
  devHolders: number | null;
  devHoldingPercent: number | null;
  smartMoneyHolders: number | null;
  smartMoneyHoldingPercent: number | null;
};

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
  if (value.startsWith('/')) return `${BINANCE_STATIC_BASE}${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function normalizeBinanceMarketChain(raw: unknown): string {
  const value = normalizeText(raw);
  return value ? BINANCE_CHAIN_ID_TO_MARKET_CHAIN[value] ?? '' : '';
}

function normalizeBinanceChainIdForMarketChain(chain: string): string | null {
  const value = normalizeText(chain)?.toLowerCase();
  if (!value) return null;
  return MARKET_CHAIN_TO_BINANCE_CHAIN_ID[value] ?? null;
}

export function resolveBinanceSearchChainIds(chains?: string[]): string[] {
  const sourceChains = Array.isArray(chains) && chains.length > 0
    ? chains
    : Object.keys(MARKET_CHAIN_TO_BINANCE_CHAIN_ID);
  const uniqueChainIds = new Set<string>();

  for (const chain of sourceChains) {
    const chainId = normalizeBinanceChainIdForMarketChain(chain);
    if (chainId) uniqueChainIds.add(chainId);
  }

  return [...uniqueChainIds];
}

function toBinanceNativeContract(chain: string): string {
  if (chain === 'sol') return 'native';
  return 'native';
}

function isBinanceNativeLookupContract(chain: string, contract: string): boolean {
  const normalizedChain = normalizeText(chain)?.toLowerCase();
  if (!normalizedChain) return false;
  const normalizedContract = normalizeText(contract);
  return !normalizedContract || normalizedContract.toLowerCase() === 'native';
}

function normalizeBinanceTokenLookupContract(
  chain: string,
  contract: string,
  options?: { preferWrappedNative?: boolean },
): string | null {
  const normalizedChain = normalizeText(chain)?.toLowerCase();
  if (!normalizedChain) return null;
  const normalizedContract = normalizeText(contract);
  if (!normalizedContract || normalizedContract.toLowerCase() === 'native') {
    if (options?.preferWrappedNative) {
      return BINANCE_WEB3_WRAPPED_NATIVE_CONTRACTS[normalizedChain] ?? null;
    }
    return BINANCE_WEB3_NATIVE_CONTRACT_SENTINEL;
  }
  return normalizedChain === 'sol' ? normalizedContract : normalizedContract.toLowerCase();
}

function normalizeBinanceTokenLinkArray(raw: unknown): Array<{ label: string; link: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const row = entry as Record<string, unknown>;
      const label = normalizeText(row.label);
      const link = normalizeText(row.link);
      if (!label || !link) return null;
      return { label, link };
    })
    .filter((entry): entry is { label: string; link: string } => entry != null);
}

function normalizeBinancePreviewLinks(raw: unknown): BinanceTokenMeta['previewLink'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const normalizeList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((item) => normalizeText(item)).filter((item): item is string => item != null)
      : [];
  return {
    website: normalizeList(row.website),
    x: normalizeList(row.x),
    tg: normalizeList(row.tg),
  };
}

function normalizeBinanceTokenAddresses(raw: unknown): BinanceTokenMeta['tokenAddresses'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const row = entry as Record<string, unknown>;
      return {
        chainId: normalizeText(row.chainId),
        contractAddress: normalizeText(row.contractAddress),
        nativeAddressFlag: row.nativeAddressFlag === true,
        lsdFlag: toFiniteNumber(row.lsdFlag),
        decimals: toFiniteNumber(row.decimals),
      };
    })
    .filter((entry): entry is NonNullable<BinanceTokenMeta['tokenAddresses'][number]> => entry != null);
}

function normalizeBinanceTokenMeta(raw: unknown): BinanceTokenMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  return {
    tokenId: normalizeText(row.tokenId),
    name: normalizeText(row.name),
    symbol: normalizeText(row.symbol),
    chainId: normalizeText(row.chainId),
    chainName: normalizeText(row.chainName),
    contractAddress: normalizeText(row.contractAddress),
    decimals: toFiniteNumber(row.decimals),
    icon: normalizeBinanceIconUrl(row.icon),
    nativeAddressFlag: row.nativeAddressFlag === true,
    lsdFlag: toFiniteNumber(row.lsdFlag),
    aiNarrativeFlag: toFiniteNumber(row.aiNarrativeFlag),
    links: normalizeBinanceTokenLinkArray(row.links),
    previewLink: normalizeBinancePreviewLinks(row.previewLink),
    tokenAddresses: normalizeBinanceTokenAddresses(row.tokenAddresses),
    createTime: toFiniteNumber(row.createTime),
    creatorAddress: normalizeText(row.creatorAddress),
    auditInfo:
      row.auditInfo && typeof row.auditInfo === 'object' && !Array.isArray(row.auditInfo)
        ? {
            isBlacklist: (row.auditInfo as Record<string, unknown>).isBlacklist === true,
            isWhitelist: (row.auditInfo as Record<string, unknown>).isWhitelist === true,
          }
        : null,
    description: normalizeText(row.description),
    rwaType: toFiniteNumber(row.rwaType),
  };
}

function normalizeBinanceTokenDynamicInfo(raw: unknown): BinanceTokenDynamicInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  return {
    price: toFiniteNumber(row.price),
    nativeTokenPrice: toFiniteNumber(row.nativeTokenPrice),
    volume24h: toFiniteNumber(row.volume24h),
    volume24hBuy: toFiniteNumber(row.volume24hBuy),
    volume24hSell: toFiniteNumber(row.volume24hSell),
    volume4h: toFiniteNumber(row.volume4h),
    volume1h: toFiniteNumber(row.volume1h),
    volume5m: toFiniteNumber(row.volume5m),
    count24h: toFiniteNumber(row.count24h),
    count24hBuy: toFiniteNumber(row.count24hBuy),
    count24hSell: toFiniteNumber(row.count24hSell),
    percentChange5m: toFiniteNumber(row.percentChange5m),
    percentChange1h: toFiniteNumber(row.percentChange1h),
    percentChange4h: toFiniteNumber(row.percentChange4h),
    percentChange24h: toFiniteNumber(row.percentChange24h),
    marketCap: toFiniteNumber(row.marketCap),
    totalSupply: toFiniteNumber(row.totalSupply),
    circulatingSupply: toFiniteNumber(row.circulatingSupply),
    priceHigh24h: toFiniteNumber(row.priceHigh24h),
    priceLow24h: toFiniteNumber(row.priceLow24h),
    holders: toFiniteNumber(row.holders),
    fdv: toFiniteNumber(row.fdv),
    liquidity: toFiniteNumber(row.liquidity),
    launchTime: toFiniteNumber(row.launchTime),
    top10HoldersPercentage: toFiniteNumber(row.top10HoldersPercentage),
    kycHolderCount: toFiniteNumber(row.kycHolderCount),
    kolHolders: toFiniteNumber(row.kolHolders),
    kolHoldingPercent: toFiniteNumber(row.kolHoldingPercent),
    proHolders: toFiniteNumber(row.proHolders),
    proHoldingPercent: toFiniteNumber(row.proHoldingPercent),
    newWalletHolders: toFiniteNumber(row.newWalletHolders),
    newWalletHoldingPercent: toFiniteNumber(row.newWalletHoldingPercent),
    devHolders: toFiniteNumber(row.devHolders),
    devHoldingPercent: toFiniteNumber(row.devHoldingPercent),
    smartMoneyHolders: toFiniteNumber(row.smartMoneyHolders),
    smartMoneyHoldingPercent: toFiniteNumber(row.smartMoneyHoldingPercent),
  };
}

async function fetchBinanceWeb3Json<T>(
  url: string,
): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'User-Agent': 'binance-web3/1.0 (Skill)',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`binance_web3_http_${response.status}:${detail.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

async function fetchBinanceTokenMetaByContract(
  chainId: string,
  contractAddress: string,
): Promise<BinanceTokenMeta | null> {
  const query = new URLSearchParams({
    chainId,
    contractAddress,
  });
  const payload = await fetchBinanceWeb3Json<{ data?: unknown }>(`${BINANCE_WEB3_TOKEN_META_URL}?${query.toString()}`);
  return normalizeBinanceTokenMeta(payload?.data);
}

async function fetchBinanceTokenDynamicInfoByContract(
  chainId: string,
  contractAddress: string,
): Promise<BinanceTokenDynamicInfo | null> {
  const query = new URLSearchParams({
    chainId,
    contractAddress,
  });
  const payload = await fetchBinanceWeb3Json<{ data?: unknown }>(`${BINANCE_WEB3_TOKEN_DYNAMIC_URL}?${query.toString()}`);
  return normalizeBinanceTokenDynamicInfo(payload?.data);
}

export async function fetchBinanceTokenMeta(
  chain: string,
  contract: string,
): Promise<BinanceTokenMeta | null> {
  const chainId = normalizeBinanceChainIdForMarketChain(chain);
  if (!chainId) return null;

  const normalizedContract = normalizeBinanceTokenLookupContract(chain, contract);
  if (!normalizedContract) return null;

  const meta = await fetchBinanceTokenMetaByContract(chainId, normalizedContract);
  if (meta || !isBinanceNativeLookupContract(chain, contract)) return meta;

  const wrappedContract = normalizeBinanceTokenLookupContract(chain, contract, { preferWrappedNative: true });
  if (!wrappedContract || wrappedContract === normalizedContract) return meta;
  return fetchBinanceTokenMetaByContract(chainId, wrappedContract).catch(() => meta);
}

export async function fetchBinanceTokenDynamicInfo(
  chain: string,
  contract: string,
): Promise<BinanceTokenDynamicInfo | null> {
  const chainId = normalizeBinanceChainIdForMarketChain(chain);
  if (!chainId) return null;

  const normalizedContract = normalizeBinanceTokenLookupContract(chain, contract);
  if (!normalizedContract) return null;

  const dynamic = await fetchBinanceTokenDynamicInfoByContract(chainId, normalizedContract);
  if (dynamic || !isBinanceNativeLookupContract(chain, contract)) return dynamic;

  const wrappedContract = normalizeBinanceTokenLookupContract(chain, contract, { preferWrappedNative: true });
  if (!wrappedContract || wrappedContract === normalizedContract) return dynamic;
  return fetchBinanceTokenDynamicInfoByContract(chainId, wrappedContract).catch(() => dynamic);
}

function pickPrimaryBinanceAddress(token: BinanceWeb3SearchToken): {
  chain: string;
  contract: string;
  nativeAddressFlag: boolean;
} | null {
  const tokenAddresses = Array.isArray(token.tokenAddresses) ? token.tokenAddresses : [];
  for (const entry of tokenAddresses) {
    const chain = normalizeBinanceMarketChain(entry.chainId);
    if (!chain) continue;
    if (entry.nativeAddressFlag) {
      return { chain, contract: toBinanceNativeContract(chain), nativeAddressFlag: true };
    }
    const contract = normalizeText(entry.contractAddress);
    if (!contract) continue;
    return { chain, contract, nativeAddressFlag: false };
  }

  const chain = normalizeBinanceMarketChain(token.chainId);
  if (!chain) return null;
  const contract = normalizeText(token.contractAddress);
  if (contract) return { chain, contract, nativeAddressFlag: false };
  return null;
}

function mapWeb3SearchTokenToItem(token: BinanceWeb3SearchToken): BinanceSpotSearchItem | null {
  const tokenId = normalizeText(token.tokenId);
  const symbol = normalizeText(token.symbol);
  const name = normalizeText(token.name);
  if (!tokenId || !symbol || !name) return null;
  const primaryAddress = pickPrimaryBinanceAddress(token);
  if (!primaryAddress) return null;
  return {
    id: `binance-token:${tokenId}`,
    symbol,
    name,
    image: normalizeBinanceIconUrl(token.icon),
    chain: primaryAddress.chain,
    contract: primaryAddress.contract,
    currentPrice: toFiniteNumber(token.price),
    change24h: toFiniteNumber(token.percentChange24h),
    volume24h: toFiniteNumber(token.volume24h),
    marketCap: toFiniteNumber(token.marketCap),
    nativeAddressFlag: primaryAddress.nativeAddressFlag,
  };
}

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
const WEB3_KLINE_INTERVAL_MAP: Record<string, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
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

function normalizeBinanceKlinePlatform(chain: string): string | null {
  const normalizedChain = normalizeText(chain)?.toLowerCase();
  if (!normalizedChain) return null;
  return MARKET_CHAIN_TO_BINANCE_KLINE_PLATFORM[normalizedChain] ?? null;
}

function normalizeBinanceKlineAddress(chain: string, contract: string): string | null {
  const normalizedChain = normalizeText(chain)?.toLowerCase();
  if (!normalizedChain) return null;
  const normalizedContract = normalizeText(contract);
  if (!normalizedContract || normalizedContract.toLowerCase() === 'native') {
    return BINANCE_WEB3_WRAPPED_NATIVE_CONTRACTS[normalizedChain] ?? null;
  }
  return normalizedChain === 'sol' ? normalizedContract : normalizedContract.toLowerCase();
}

type BinanceWeb3KlinePayload = {
  data?: unknown;
  status?: {
    error_code?: number | string;
    error_message?: string;
  };
};

export async function fetchBinanceWeb3TokenKlines(
  chain: string,
  contract: string,
  period: string,
  size: number,
): Promise<BinanceKlineCandle[]> {
  const platform = normalizeBinanceKlinePlatform(chain);
  const address = normalizeBinanceKlineAddress(chain, contract);
  const interval = WEB3_KLINE_INTERVAL_MAP[(period ?? '').trim().toLowerCase()];
  if (!platform || !address || !interval) return [];

  const limit = Math.max(10, Math.min(Math.trunc(size || 60), 500));
  const query = new URLSearchParams({
    address,
    platform,
    interval,
    limit: String(limit),
    pm: 'p',
  });
  const payload = await fetchBinanceWeb3Json<BinanceWeb3KlinePayload>(`${BINANCE_WEB3_KLINE_URL}?${query.toString()}`);
  const errorCode = String(payload?.status?.error_code ?? '0').trim();
  if (errorCode !== '0') {
    throw new Error(`binance_web3_kline_error:${payload?.status?.error_message ?? 'unknown_error'}`);
  }
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 6) return null;
      const open = toFiniteNumber(row[0]);
      const high = toFiniteNumber(row[1]);
      const low = toFiniteNumber(row[2]);
      const close = toFiniteNumber(row[3]);
      const turnover = toFiniteNumber(row[4]);
      const time = toFiniteNumber(row[5]);
      if (time == null || open == null || high == null || low == null || close == null) return null;
      const timeSeconds = time >= 1e11 ? Math.round(time / 1000) : Math.round(time);
      return {
        time: timeSeconds,
        open,
        high,
        low,
        close,
        turnover,
      } satisfies BinanceKlineCandle;
    })
    .filter((item): item is BinanceKlineCandle => item != null)
    .sort((a, b) => a.time - b.time);
}

export async function searchBinanceSpotTokens(
  query: string,
  limit = 20,
  options?: {
    chains?: string[];
  },
): Promise<BinanceSpotSearchItem[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const chainIds = resolveBinanceSearchChainIds(options?.chains);
  if (chainIds.length === 0) return [];

  const searchParams = new URLSearchParams({
    keyword: normalizedQuery,
    chainIds: chainIds.join(','),
    orderBy: 'volume24h',
  });
  const response = await fetch(`${BINANCE_WEB3_SEARCH_URL}?${searchParams.toString()}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'agentic-wallet-search/1.0',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`binance_web3_search_http_${response.status}:${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { data?: BinanceWeb3SearchToken[] };
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map(mapWeb3SearchTokenToItem)
    .filter((item): item is BinanceSpotSearchItem => item != null)
    .slice(0, limit);
}
