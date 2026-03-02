import type { Bindings } from '../types';
import {
  buildAssetId,
  buildChainAssetId,
  contractKeyToUpstreamContract,
  normalizeMarketChain,
  toContractKey,
} from './assetIdentity';

const BGW_BASE_URL = 'https://bopenapi.bgwapi.io';
const TOKEN_DETAIL_CACHE_TTL_MS = 15_000;
const TOKEN_KLINE_CACHE_TTL_MS = 12_000;

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

type BitgetEnvelope<T> = {
  status?: number | string;
  code?: number | string;
  msg?: string;
  message?: string;
  data?: T;
};

export type TopAssetListName = 'topGainers' | 'topLosers' | 'topVolume' | 'marketCap' | 'trending';

type BitgetTopRankRow = {
  chain?: string;
  contract?: string;
  symbol?: string;
  name?: string;
  icon?: string;
  price?: number | string;
  change_24h?: number | string;
  market_cap?: number | string;
  turnover_24h?: number | string;
  risk_level?: string;
};

type BitgetBaseInfoRow = {
  chain?: string;
  contract?: string;
  symbol?: string;
  name?: string;
  decimals?: number | string;
  total_supply?: number | string;
  holders?: number | string;
  liquidity?: number | string;
  top10_holder_percent?: number | string;
  insider_holder_percent?: number | string;
  sniper_holder_percent?: number | string;
  dev_holder_percent?: number | string;
  dev_holder_balance?: number | string;
  dev_issue_coin_count?: number | string;
  dev_rug_coin_count?: number | string;
  dev_rug_percent?: number | string;
  lock_lp_percent?: number | string;
  price?: number | string;
};

type BitgetKlineRow = {
  ts?: number | string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  turnover?: number | string;
};

const tokenDetailValueCache = new Map<string, { expiresAt: number; value: BitgetTokenDetail | null }>();
const tokenDetailInFlightCache = new Map<string, Promise<BitgetTokenDetail | null>>();
const tokenKlineValueCache = new Map<string, { expiresAt: number; value: BitgetKlineCandle[] }>();
const tokenKlineInFlightCache = new Map<string, Promise<BitgetKlineCandle[]>>();

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

function buildTokenDetailCacheKey(chain: string, contract: string): string {
  return `${normalizeMarketChain(chain)}:${toContractKey(contract)}`;
}

function buildTokenKlineCacheKey(options: {
  chain: string;
  contract: string;
  period?: string;
  size?: number;
}): { cacheKey: string; chain: string; contract: string; period: string; size: number } {
  const chain = normalizeMarketChain(options.chain);
  const contract = toContractKey(options.contract);
  const period = normalizeText(options.period) ?? '1h';
  const size = clampInt(options.size ?? 60, 5, 300);
  return {
    cacheKey: `${chain}:${contract}:${period}:${size}`,
    chain,
    contract,
    period,
    size,
  };
}

function stableSortJson(input: JsonLike): JsonLike {
  if (Array.isArray(input)) {
    return input.map((item) => stableSortJson(item));
  }
  if (input && typeof input === 'object') {
    const output: { [key: string]: JsonLike } = {};
    for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
      output[key] = stableSortJson(input[key]);
    }
    return output;
  }
  return input;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const secretKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', secretKey, new TextEncoder().encode(payload));
  return arrayBufferToBase64(signature);
}

async function bitgetPost<TData>(
  env: Bindings,
  apiPath: string,
  body?: JsonLike,
): Promise<BitgetEnvelope<TData>> {
  const apiKey = env.BGW_API_KEY?.trim();
  const apiSecret = env.BGW_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    throw new Error('bgw_credentials_not_configured');
  }
  const timestamp = String(Date.now());
  const canonicalBody = body == null ? '' : JSON.stringify(stableSortJson(body));
  const signContent = JSON.stringify(
    Object.fromEntries(
      Object.entries({
        apiPath,
        body: canonicalBody,
        'x-api-key': apiKey,
        'x-api-timestamp': timestamp,
      }).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  const signature = await signPayload(apiSecret, signContent);

  const response = await fetch(`${BGW_BASE_URL}${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'x-api-timestamp': timestamp,
      'x-api-signature': signature,
    },
    body: canonicalBody || undefined,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`bgw_http_${response.status}:${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as BitgetEnvelope<TData>;

  const statusValue = Number(payload.status);
  const codeRaw = payload.code;
  const codeValue = Number(codeRaw);
  const codeText = typeof codeRaw === 'string' ? codeRaw.trim() : '';
  const statusOk =
    payload.status == null
    || (Number.isFinite(statusValue) && statusValue === 0)
    || String(payload.status).trim() === '0';
  const codeOk =
    codeRaw == null
    || (Number.isFinite(codeValue) && codeValue === 0)
    || codeText === '0'
    || codeText === '00000';
  if (!statusOk || !codeOk) {
    const message = normalizeText(payload.msg) ?? normalizeText(payload.message) ?? 'bgw_business_error';
    throw new Error(`bgw_business_error:${message}`);
  }

  return payload;
}

export type MarketTopAsset = {
  id: string;
  asset_id: string;
  chain_asset_id: string;
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  image: string | null;
  current_price: number | null;
  market_cap_rank: number | null;
  market_cap: number | null;
  price_change_percentage_24h: number | null;
  turnover_24h: number | null;
  risk_level: string | null;
};

export type BitgetTopMarketAsset = MarketTopAsset;

export async function fetchBitgetTopMarketAssets(
  env: Bindings,
  options?: {
    name?: TopAssetListName;
    limit?: number;
    chains?: string[];
  },
): Promise<MarketTopAsset[]> {
  const listName = options?.name === 'topLosers' ? 'topLosers' : 'topGainers';
  const limit = clampInt(options?.limit ?? 30, 1, 100);
  const chainFilter = new Set(
    (options?.chains ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );

  const result = await bitgetPost<{ list?: BitgetTopRankRow[] }>(env, '/bgw-pro/market/v3/topRank/detail', {
    name: listName,
  });

  const rows = Array.isArray(result.data?.list) ? result.data?.list : [];
  const filtered =
    chainFilter.size > 0
      ? rows.filter((item) => chainFilter.has((item.chain ?? '').trim().toLowerCase()))
      : rows;

  return filtered.slice(0, limit).map((row, idx) => {
    const chain = normalizeMarketChain(row.chain);
    const contract = normalizeText(row.contract) ?? '';
    const chainAssetId = buildChainAssetId(chain, contract);
    const assetId = buildAssetId(chain, contract);
    const symbol = normalizeText(row.symbol) ?? 'UNKNOWN';
    const name = normalizeText(row.name) ?? symbol;
    return {
      id: chainAssetId,
      asset_id: assetId,
      chain_asset_id: chainAssetId,
      chain,
      contract,
      symbol,
      name,
      image: normalizeText(row.icon),
      current_price: normalizeFiniteNumber(row.price),
      market_cap_rank: idx + 1,
      market_cap: normalizeFiniteNumber(row.market_cap),
      price_change_percentage_24h: normalizeFiniteNumber(row.change_24h),
      turnover_24h: normalizeFiniteNumber(row.turnover_24h),
      risk_level: normalizeText(row.risk_level),
    };
  });
}

export type BitgetTokenDetail = {
  asset_id: string;
  chain_asset_id: string;
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  currentPriceUsd: number | null;
  holders: number | null;
  totalSupply: number | null;
  liquidityUsd: number | null;
  top10HolderPercent: number | null;
  devHolderPercent: number | null;
  lockLpPercent: number | null;
};

export async function fetchBitgetTokenDetail(
  env: Bindings,
  chain: string,
  contract: string,
): Promise<BitgetTokenDetail | null> {
  const cacheKey = buildTokenDetailCacheKey(chain, contract);
  const now = Date.now();
  const cached = tokenDetailValueCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inFlight = tokenDetailInFlightCache.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const result = await bitgetPost<{ list?: BitgetBaseInfoRow[] }>(
      env,
      '/bgw-pro/market/v3/coin/batchGetBaseInfo',
      {
        list: [{ chain, contract: contractKeyToUpstreamContract(contract) }],
      },
    );
    const row = Array.isArray(result.data?.list) ? result.data?.list[0] : undefined;
    const value: BitgetTokenDetail | null = row
      ? (() => {
          const normalizedChain = normalizeMarketChain(normalizeText(row.chain) ?? chain);
          const normalizedContract = normalizeText(row.contract) ?? contractKeyToUpstreamContract(contract);
          return {
            asset_id: buildAssetId(normalizedChain, normalizedContract),
            chain_asset_id: buildChainAssetId(normalizedChain, normalizedContract),
            chain: normalizedChain,
            contract: toContractKey(normalizedContract) === 'native' ? '' : normalizedContract,
            symbol: normalizeText(row.symbol) ?? 'UNKNOWN',
            name: normalizeText(row.name) ?? normalizeText(row.symbol) ?? 'Unknown Token',
            currentPriceUsd: normalizeFiniteNumber(row.price),
            holders: normalizeFiniteNumber(row.holders),
            totalSupply: normalizeFiniteNumber(row.total_supply),
            liquidityUsd: normalizeFiniteNumber(row.liquidity),
            top10HolderPercent: normalizeFiniteNumber(row.top10_holder_percent),
            devHolderPercent: normalizeFiniteNumber(row.dev_holder_percent),
            lockLpPercent: normalizeFiniteNumber(row.lock_lp_percent),
          };
        })()
      : null;
    tokenDetailValueCache.set(cacheKey, {
      expiresAt: Date.now() + TOKEN_DETAIL_CACHE_TTL_MS,
      value,
    });
    return value;
  })().finally(() => {
    tokenDetailInFlightCache.delete(cacheKey);
  });

  tokenDetailInFlightCache.set(cacheKey, task);
  return task;
}

export type BitgetKlineCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number | null;
};

export async function fetchBitgetTokenKline(
  env: Bindings,
  options: {
    chain: string;
    contract: string;
    period?: string;
    size?: number;
  },
): Promise<BitgetKlineCandle[]> {
  const normalized = buildTokenKlineCacheKey(options);
  const now = Date.now();
  const cached = tokenKlineValueCache.get(normalized.cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inFlight = tokenKlineInFlightCache.get(normalized.cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const result = await bitgetPost<{ list?: BitgetKlineRow[] }>(env, '/bgw-pro/market/v3/coin/getKline', {
      chain: normalized.chain,
      contract: contractKeyToUpstreamContract(normalized.contract),
      period: normalized.period,
      size: normalized.size,
    });
    const rows = Array.isArray(result.data?.list) ? result.data?.list : [];

    const value = rows
      .map((row) => {
        const time = normalizeFiniteNumber(row.ts);
        const open = normalizeFiniteNumber(row.open);
        const high = normalizeFiniteNumber(row.high);
        const low = normalizeFiniteNumber(row.low);
        const close = normalizeFiniteNumber(row.close);
        if (time == null || open == null || high == null || low == null || close == null) {
          return null;
        }
        return {
          time,
          open,
          high,
          low,
          close,
          turnover: normalizeFiniteNumber(row.turnover),
        } satisfies BitgetKlineCandle;
      })
      .filter((item): item is BitgetKlineCandle => item != null)
      .sort((a, b) => a.time - b.time);

    tokenKlineValueCache.set(normalized.cacheKey, {
      expiresAt: Date.now() + TOKEN_KLINE_CACHE_TTL_MS,
      value,
    });
    return value;
  })().finally(() => {
    tokenKlineInFlightCache.delete(normalized.cacheKey);
  });

  tokenKlineInFlightCache.set(normalized.cacheKey, task);
  return task;
}
