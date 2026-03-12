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
const TOKEN_SECURITY_CACHE_TTL_MS = 30_000;

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
  icon?: string;
  change_24h?: number | string;
  price_change_percentage_24h?: number | string;
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

type BitgetSecurityCheckRow = {
  labelName?: string;
  status?: number | string;
  priority?: number | string;
  type?: number | string;
  values?: Record<string, unknown>;
};

type BitgetSecurityAuditRow = {
  chain?: string;
  contract?: string;
  riskChecks?: BitgetSecurityCheckRow[];
  warnChecks?: BitgetSecurityCheckRow[];
  lowChecks?: BitgetSecurityCheckRow[];
  riskCount?: number | string;
  warnCount?: number | string;
  checkStatus?: number | string;
  support?: number | string | boolean;
  checking?: boolean | number | string;
  buyTax?: number | string;
  sellTax?: number | string;
  freezeAuth?: boolean | number | string;
  mintAuth?: boolean | number | string;
  token2022?: boolean | number | string;
  lpLock?: boolean | number | string;
  top_10_holder_risk_level?: number | string;
  highRisk?: boolean | number | string;
  cannotSellAll?: boolean | number | string;
  isProxy?: boolean | number | string;
};

const tokenDetailValueCache = new Map<string, { expiresAt: number; value: BitgetTokenDetail | null }>();
const tokenDetailInFlightCache = new Map<string, Promise<BitgetTokenDetail | null>>();
const tokenKlineValueCache = new Map<string, { expiresAt: number; value: BitgetKlineCandle[] }>();
const tokenKlineInFlightCache = new Map<string, Promise<BitgetKlineCandle[]>>();
const tokenSecurityValueCache = new Map<string, { expiresAt: number; value: BitgetTokenSecurityAudit | null }>();
const tokenSecurityInFlightCache = new Map<string, Promise<BitgetTokenSecurityAudit | null>>();

function normalizeFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeBoolean(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true';
  }
  return false;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function buildTokenDetailCacheKey(chain: string, contract: string): string {
  const normalizedChain = normalizeMarketChain(chain);
  return `${normalizedChain}:${toContractKey(contract, normalizedChain)}`;
}

type NormalizedTokenDetailLookup = {
  cacheKey: string;
  chain: string;
  contract: string;
};

function normalizeTokenDetailLookup(
  input: {
    chain: string;
    contract: string;
  },
): NormalizedTokenDetailLookup | null {
  const normalizedChain = normalizeText(input.chain);
  if (!normalizedChain) return null;
  const chain = normalizeMarketChain(normalizedChain);
  const contract = toContractKey(input.contract, chain);
  return {
    cacheKey: buildTokenDetailCacheKey(chain, contract),
    chain,
    contract,
  };
}

function buildTokenKlineCacheKey(options: {
  chain: string;
  contract: string;
  period?: string;
  size?: number;
}): { cacheKey: string; chain: string; contract: string; period: string; size: number } {
  const chain = normalizeMarketChain(options.chain);
  const contract = toContractKey(options.contract, chain);
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
  instrument_id?: string;
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
    const contractKey = toContractKey(contract, chain);
    const chainAssetId = buildChainAssetId(chain, contract);
    const assetId = buildAssetId(chain, contract);
    const instrumentId = `ins:spot:${chain}:${contractKey}`;
    const symbol = normalizeText(row.symbol) ?? 'UNKNOWN';
    const name = normalizeText(row.name) ?? symbol;
    return {
      id: chainAssetId,
      asset_id: assetId,
      instrument_id: instrumentId,
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
  image: string | null;
  priceChange24h: number | null;
  currentPriceUsd: number | null;
  holders: number | null;
  totalSupply: number | null;
  liquidityUsd: number | null;
  top10HolderPercent: number | null;
  devHolderPercent: number | null;
  lockLpPercent: number | null;
};

function mapBitgetBaseInfoRowToTokenDetail(
  row: BitgetBaseInfoRow,
  fallback: {
    chain: string;
    contract: string;
  },
): BitgetTokenDetail {
  const normalizedChain = normalizeMarketChain(normalizeText(row.chain) ?? fallback.chain);
  const normalizedContract = normalizeText(row.contract) ?? contractKeyToUpstreamContract(fallback.contract, normalizedChain);
  return {
    asset_id: buildAssetId(normalizedChain, normalizedContract),
    chain_asset_id: buildChainAssetId(normalizedChain, normalizedContract),
    chain: normalizedChain,
    contract: toContractKey(normalizedContract, normalizedChain) === 'native' ? '' : normalizedContract,
    symbol: normalizeText(row.symbol) ?? 'UNKNOWN',
    name: normalizeText(row.name) ?? normalizeText(row.symbol) ?? 'Unknown Token',
    image: normalizeText(row.icon),
    priceChange24h:
      normalizeFiniteNumber(row.change_24h)
      ?? normalizeFiniteNumber(row.price_change_percentage_24h),
    currentPriceUsd: normalizeFiniteNumber(row.price),
    holders: normalizeFiniteNumber(row.holders),
    totalSupply: normalizeFiniteNumber(row.total_supply),
    liquidityUsd: normalizeFiniteNumber(row.liquidity),
    top10HolderPercent: normalizeFiniteNumber(row.top10_holder_percent),
    devHolderPercent: normalizeFiniteNumber(row.dev_holder_percent),
    lockLpPercent: normalizeFiniteNumber(row.lock_lp_percent),
  };
}

export type BitgetTokenDetailBatchItem = {
  key: string;
  chain: string;
  contract: string;
  detail: BitgetTokenDetail | null;
};

export async function fetchBitgetTokenDetails(
  env: Bindings,
  requests: Array<{
    chain: string;
    contract: string;
  }>,
): Promise<BitgetTokenDetailBatchItem[]> {
  const normalizedRequests = requests
    .map((item) => normalizeTokenDetailLookup(item))
    .filter((item): item is NormalizedTokenDetailLookup => item != null);
  if (normalizedRequests.length === 0) return [];

  const uniqueLookups = [...new Map(normalizedRequests.map((item) => [item.cacheKey, item])).values()];
  const detailByCacheKey = new Map<string, BitgetTokenDetail | null>();
  const now = Date.now();
  const pending: Array<Promise<void>> = [];
  const misses: NormalizedTokenDetailLookup[] = [];

  for (const lookup of uniqueLookups) {
    const cached = tokenDetailValueCache.get(lookup.cacheKey);
    if (cached && cached.expiresAt > now) {
      detailByCacheKey.set(lookup.cacheKey, cached.value);
      continue;
    }
    const inFlight = tokenDetailInFlightCache.get(lookup.cacheKey);
    if (inFlight) {
      pending.push(
        inFlight.then((value) => {
          detailByCacheKey.set(lookup.cacheKey, value);
        }),
      );
      continue;
    }
    misses.push(lookup);
  }

  if (misses.length > 0) {
    const batchTask = (async () => {
      const result = await bitgetPost<{ list?: BitgetBaseInfoRow[] }>(
        env,
        '/bgw-pro/market/v3/coin/batchGetBaseInfo',
        {
          list: misses.map((item) => ({
            chain: item.chain,
            contract: contractKeyToUpstreamContract(item.contract),
          })),
        },
      );
      const rows = Array.isArray(result.data?.list) ? result.data.list : [];
      const rowByCacheKey = new Map<string, BitgetTokenDetail>();

      for (const row of rows) {
        const rowLookup = normalizeTokenDetailLookup({
          chain: normalizeText(row.chain) ?? '',
          contract: normalizeText(row.contract) ?? '',
        });
        if (!rowLookup || rowByCacheKey.has(rowLookup.cacheKey)) continue;
        rowByCacheKey.set(
          rowLookup.cacheKey,
          mapBitgetBaseInfoRowToTokenDetail(row, {
            chain: rowLookup.chain,
            contract: rowLookup.contract,
          }),
        );
      }

      for (let i = 0; i < misses.length; i += 1) {
        const lookup = misses[i];
        if (rowByCacheKey.has(lookup.cacheKey)) continue;
        const row = rows[i];
        if (!row) continue;
        rowByCacheKey.set(
          lookup.cacheKey,
          mapBitgetBaseInfoRowToTokenDetail(row, {
            chain: lookup.chain,
            contract: lookup.contract,
          }),
        );
      }

      const expiresAt = Date.now() + TOKEN_DETAIL_CACHE_TTL_MS;
      for (const lookup of misses) {
        const value = rowByCacheKey.get(lookup.cacheKey) ?? null;
        tokenDetailValueCache.set(lookup.cacheKey, { expiresAt, value });
        detailByCacheKey.set(lookup.cacheKey, value);
      }
    })().finally(() => {
      for (const lookup of misses) {
        tokenDetailInFlightCache.delete(lookup.cacheKey);
      }
    });

    for (const lookup of misses) {
      const itemTask = batchTask.then(() => detailByCacheKey.get(lookup.cacheKey) ?? null);
      tokenDetailInFlightCache.set(lookup.cacheKey, itemTask);
      pending.push(
        itemTask.then((value) => {
          detailByCacheKey.set(lookup.cacheKey, value);
        }),
      );
    }
  }

  if (pending.length > 0) {
    await Promise.all(pending);
  }

  return normalizedRequests.map((item) => ({
    key: item.cacheKey,
    chain: item.chain,
    contract: item.contract === 'native' ? '' : item.contract,
    detail: detailByCacheKey.get(item.cacheKey) ?? null,
  }));
}

export async function fetchBitgetTokenDetail(
  env: Bindings,
  chain: string,
  contract: string,
): Promise<BitgetTokenDetail | null> {
  const normalized = normalizeTokenDetailLookup({ chain, contract });
  if (!normalized) return null;
  const results = await fetchBitgetTokenDetails(env, [
    {
      chain: normalized.chain,
      contract: normalized.contract,
    },
  ]);
  return results[0]?.detail ?? null;
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
  const staleValue = cached?.value ?? null;
  const inFlight = tokenKlineInFlightCache.get(normalized.cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    let result: BitgetEnvelope<{ list?: BitgetKlineRow[] }>;
    try {
      result = await bitgetPost<{ list?: BitgetKlineRow[] }>(env, '/bgw-pro/market/v3/coin/getKline', {
        chain: normalized.chain,
        contract: contractKeyToUpstreamContract(normalized.contract, normalized.chain),
        period: normalized.period,
        size: normalized.size,
      });
    } catch (error) {
      // Upstream rate limiting is common; keep chart usable with stale cache.
      if (staleValue && staleValue.length > 0) {
        return staleValue;
      }
      throw error;
    }
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

export type BitgetTokenSecurityCheck = {
  labelName: string | null;
  status: number | null;
  priority: number | null;
  type: number | null;
  values: Record<string, string | number | boolean | null> | null;
};

export type BitgetTokenSecurityAudit = {
  asset_id: string;
  chain_asset_id: string;
  chain: string;
  contract: string;
  riskChecks: BitgetTokenSecurityCheck[];
  warnChecks: BitgetTokenSecurityCheck[];
  lowChecks: BitgetTokenSecurityCheck[];
  riskCount: number;
  warnCount: number;
  totalChecks: number;
  checkStatus: number | null;
  supported: boolean;
  checking: boolean;
  buyTax: number | null;
  sellTax: number | null;
  freezeAuth: boolean;
  mintAuth: boolean;
  token2022: boolean;
  lpLock: boolean;
  top10HolderRiskLevel: number | null;
  highRisk: boolean;
  cannotSellAll: boolean;
  isProxy: boolean;
};

function normalizeSecurityCheckValues(
  raw: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | null {
  if (!raw) return null;
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : null;
}

function mapSecurityCheck(row: BitgetSecurityCheckRow): BitgetTokenSecurityCheck {
  return {
    labelName: normalizeText(row.labelName),
    status: normalizeFiniteNumber(row.status),
    priority: normalizeFiniteNumber(row.priority),
    type: normalizeFiniteNumber(row.type),
    values: normalizeSecurityCheckValues(row.values),
  };
}

function mapBitgetSecurityAuditRow(
  row: BitgetSecurityAuditRow,
  fallback: {
    chain: string;
    contract: string;
  },
): BitgetTokenSecurityAudit {
  const normalizedChain = normalizeMarketChain(normalizeText(row.chain) ?? fallback.chain);
  const normalizedContract = normalizeText(row.contract) ?? contractKeyToUpstreamContract(fallback.contract, normalizedChain);
  const riskChecks = Array.isArray(row.riskChecks) ? row.riskChecks.map(mapSecurityCheck) : [];
  const warnChecks = Array.isArray(row.warnChecks) ? row.warnChecks.map(mapSecurityCheck) : [];
  const lowChecks = Array.isArray(row.lowChecks) ? row.lowChecks.map(mapSecurityCheck) : [];
  return {
    asset_id: buildAssetId(normalizedChain, normalizedContract),
    chain_asset_id: buildChainAssetId(normalizedChain, normalizedContract),
    chain: normalizedChain,
    contract: toContractKey(normalizedContract, normalizedChain) === 'native' ? '' : normalizedContract,
    riskChecks,
    warnChecks,
    lowChecks,
    riskCount: normalizeFiniteNumber(row.riskCount) ?? riskChecks.length,
    warnCount: normalizeFiniteNumber(row.warnCount) ?? warnChecks.length,
    totalChecks: riskChecks.length + warnChecks.length + lowChecks.length,
    checkStatus: normalizeFiniteNumber(row.checkStatus),
    supported: normalizeBoolean(row.support),
    checking: normalizeBoolean(row.checking),
    buyTax: normalizeFiniteNumber(row.buyTax),
    sellTax: normalizeFiniteNumber(row.sellTax),
    freezeAuth: normalizeBoolean(row.freezeAuth),
    mintAuth: normalizeBoolean(row.mintAuth),
    token2022: normalizeBoolean(row.token2022),
    lpLock: normalizeBoolean(row.lpLock),
    top10HolderRiskLevel: normalizeFiniteNumber(row.top_10_holder_risk_level),
    highRisk: normalizeBoolean(row.highRisk),
    cannotSellAll: normalizeBoolean(row.cannotSellAll),
    isProxy: normalizeBoolean(row.isProxy),
  };
}

export async function fetchBitgetTokenSecurityAudit(
  env: Bindings,
  chain: string,
  contract: string,
): Promise<BitgetTokenSecurityAudit | null> {
  const normalized = normalizeTokenDetailLookup({ chain, contract });
  if (!normalized) return null;

  const cached = tokenSecurityValueCache.get(normalized.cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inFlight = tokenSecurityInFlightCache.get(normalized.cacheKey);
  if (inFlight) return inFlight;

  const task = (async () => {
    const result = await bitgetPost<BitgetSecurityAuditRow[]>(env, '/bgw-pro/market/v3/coin/security/audits', {
      list: [
        {
          chain: normalized.chain,
          contract: contractKeyToUpstreamContract(normalized.contract, normalized.chain),
        },
      ],
      source: 'bg',
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    const matchedRow =
      rows.find((row) => {
        const rowLookup = normalizeTokenDetailLookup({
          chain: normalizeText(row.chain) ?? normalized.chain,
          contract: normalizeText(row.contract) ?? contractKeyToUpstreamContract(normalized.contract, normalized.chain),
        });
        return rowLookup?.cacheKey === normalized.cacheKey;
      })
      ?? rows[0];
    const value = matchedRow
      ? mapBitgetSecurityAuditRow(matchedRow, {
          chain: normalized.chain,
          contract: normalized.contract,
        })
      : null;
    tokenSecurityValueCache.set(normalized.cacheKey, {
      expiresAt: Date.now() + TOKEN_SECURITY_CACHE_TTL_MS,
      value,
    });
    return value;
  })().finally(() => {
    tokenSecurityInFlightCache.delete(normalized.cacheKey);
  });

  tokenSecurityInFlightCache.set(normalized.cacheKey, task);
  return task;
}
