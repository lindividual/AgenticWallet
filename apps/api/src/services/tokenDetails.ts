import type { Bindings } from '../types';
import type { BitgetTokenDetail } from './bitgetWallet';
import { fetchBitgetTokenDetails } from './bitgetWallet';
import type { BinanceTokenDynamicInfo, BinanceTokenMeta } from './binance';
import { fetchBinanceTokenDynamicInfo, fetchBinanceTokenMeta } from './binance';
import {
  fetchCoinGeckoContractMarketDetailFromD1,
  resolveCoinGeckoAssetIdForContract,
} from './coingecko';
import { buildChainAssetId, NATIVE_CONTRACT_KEY, normalizeMarketChain, toContractKey } from './assetIdentity';

type BaseTokenDetailInput = Pick<
  BitgetTokenDetail,
  | 'chain'
  | 'contract'
  | 'symbol'
  | 'name'
  | 'image'
  | 'priceChange24h'
  | 'currentPriceUsd'
  | 'holders'
  | 'totalSupply'
  | 'liquidityUsd'
  | 'top10HolderPercent'
  | 'devHolderPercent'
  | 'lockLpPercent'
>;

type NormalizedTokenDetailLookup = {
  cacheKey: string;
  chain: string;
  contract: string;
};

type BinanceFallbackResult = {
  detail: BaseTokenDetailInput;
  meta: BinanceTokenMeta | null;
  dynamic: BinanceTokenDynamicInfo | null;
};

export type ResolvedTokenDetail = {
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
  about: string | null;
  fdv: number | null;
  volume24h: number | null;
};

export type ResolvedTokenDetailBatchItem = {
  key: string;
  chain: string;
  contract: string;
  detail: ResolvedTokenDetail | null;
};

const NATIVE_COIN_ASSET_ID_BY_CHAIN: Record<string, string> = {
  eth: 'coingecko:ethereum',
  base: 'coingecko:ethereum',
  bnb: 'coingecko:binancecoin',
  tron: 'coingecko:tron',
  sol: 'coingecko:solana',
  btc: 'coingecko:bitcoin',
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function buildTokenDetailCacheKey(chain: string, contract: string): string {
  const normalizedChain = normalizeMarketChain(chain);
  return `${normalizedChain}:${toContractKey(contract, normalizedChain)}`;
}

function normalizeTokenDetailLookup(input: {
  chain: string;
  contract: string;
}): NormalizedTokenDetailLookup | null {
  const normalizedChain = normalizeText(input.chain);
  if (!normalizedChain) return null;
  const chain = normalizeMarketChain(normalizedChain);
  if (!chain || chain === 'unknown') return null;
  const contract = toContractKey(input.contract, chain);
  return {
    cacheKey: buildTokenDetailCacheKey(chain, contract),
    chain,
    contract,
  };
}

function toResponseContract(chain: string, contract: string): string {
  return toContractKey(contract, chain) === NATIVE_CONTRACT_KEY ? '' : contract;
}

async function resolveCoinAssetId(env: Bindings, chain: string, contract: string): Promise<string> {
  const normalizedChain = normalizeMarketChain(chain);
  const contractKey = toContractKey(contract, normalizedChain);
  if (contractKey === NATIVE_CONTRACT_KEY) {
    return NATIVE_COIN_ASSET_ID_BY_CHAIN[normalizedChain] ?? `chain:${normalizedChain}:${NATIVE_CONTRACT_KEY}`;
  }

  const resolved = await resolveCoinGeckoAssetIdForContract(env, normalizedChain, contractKey).catch(() => null);
  return resolved ?? `chain:${normalizedChain}:${contractKey}`;
}

async function enrichBaseTokenDetail(
  env: Bindings,
  detail: BaseTokenDetailInput,
  options?: {
    binanceMeta?: BinanceTokenMeta | null;
    binanceDynamic?: BinanceTokenDynamicInfo | null;
  },
): Promise<ResolvedTokenDetail> {
  const normalizedChain = normalizeMarketChain(detail.chain);
  const contractKey = toContractKey(detail.contract || NATIVE_CONTRACT_KEY, normalizedChain);
  const upstreamContract = toResponseContract(normalizedChain, contractKey);
  const [assetId, fetchedBinanceMeta, fetchedBinanceDynamic] = await Promise.all([
    resolveCoinAssetId(env, normalizedChain, contractKey),
    options?.binanceMeta !== undefined
      ? Promise.resolve(options.binanceMeta)
      : fetchBinanceTokenMeta(normalizedChain, upstreamContract).catch(() => null),
    options?.binanceDynamic !== undefined
      ? Promise.resolve(options.binanceDynamic)
      : fetchBinanceTokenDynamicInfo(normalizedChain, upstreamContract).catch(() => null),
  ]);
  const binanceMeta = options?.binanceMeta !== undefined ? options.binanceMeta : fetchedBinanceMeta;
  const binanceDynamic = options?.binanceDynamic !== undefined ? options.binanceDynamic : fetchedBinanceDynamic;

  return {
    asset_id: assetId,
    chain_asset_id: buildChainAssetId(normalizedChain, contractKey),
    chain: normalizedChain,
    contract: upstreamContract,
    symbol: detail.symbol,
    name: detail.name,
    image: detail.image ?? binanceMeta?.icon ?? null,
    priceChange24h: detail.priceChange24h ?? binanceDynamic?.percentChange24h ?? null,
    currentPriceUsd: detail.currentPriceUsd ?? binanceDynamic?.price ?? null,
    holders: detail.holders ?? binanceDynamic?.holders ?? null,
    totalSupply: detail.totalSupply ?? binanceDynamic?.totalSupply ?? null,
    liquidityUsd: detail.liquidityUsd ?? binanceDynamic?.liquidity ?? null,
    top10HolderPercent: detail.top10HolderPercent ?? binanceDynamic?.top10HoldersPercentage ?? null,
    devHolderPercent: detail.devHolderPercent ?? binanceDynamic?.devHoldingPercent ?? null,
    lockLpPercent: detail.lockLpPercent ?? null,
    about: binanceMeta?.description ?? null,
    fdv: binanceDynamic?.fdv ?? null,
    volume24h: binanceDynamic?.volume24h ?? null,
  };
}

async function buildBinanceTokenDetailFallback(
  chain: string,
  contract: string,
): Promise<BinanceFallbackResult | null> {
  const normalizedChain = normalizeMarketChain(chain);
  const contractKey = toContractKey(contract || NATIVE_CONTRACT_KEY, normalizedChain);
  const upstreamContract = toResponseContract(normalizedChain, contractKey);
  const [meta, dynamic] = await Promise.all([
    fetchBinanceTokenMeta(normalizedChain, upstreamContract).catch(() => null),
    fetchBinanceTokenDynamicInfo(normalizedChain, upstreamContract).catch(() => null),
  ]);

  const symbol = meta?.symbol?.trim() ?? '';
  const name = meta?.name?.trim() ?? '';
  const hasIdentity = Boolean(symbol || name);
  const hasMarketData =
    Number.isFinite(Number(dynamic?.price))
    || Number.isFinite(Number(dynamic?.percentChange24h))
    || Number.isFinite(Number(dynamic?.volume24h));

  if (!hasIdentity && !hasMarketData) return null;

  return {
    detail: {
      chain: normalizedChain,
      contract: upstreamContract,
      symbol: symbol || name || 'UNKNOWN',
      name: name || symbol || 'Unknown Token',
      image: meta?.icon ?? null,
      priceChange24h: dynamic?.percentChange24h ?? null,
      currentPriceUsd: dynamic?.price ?? null,
      holders: dynamic?.holders ?? null,
      totalSupply: dynamic?.totalSupply ?? null,
      liquidityUsd: dynamic?.liquidity ?? null,
      top10HolderPercent: dynamic?.top10HoldersPercentage ?? null,
      devHolderPercent: dynamic?.devHoldingPercent ?? null,
      lockLpPercent: null,
    },
    meta,
    dynamic,
  };
}

async function buildD1TokenDetailFallback(
  env: Bindings,
  chain: string,
  contract: string,
): Promise<ResolvedTokenDetail | null> {
  const normalizedChain = normalizeMarketChain(chain);
  const upstreamContract = toResponseContract(normalizedChain, contract);
  const detail = await fetchCoinGeckoContractMarketDetailFromD1(env, normalizedChain, upstreamContract).catch(() => null);
  if (!detail) return null;

  return {
    asset_id: detail.asset_id,
    chain_asset_id: detail.chain_asset_id,
    chain: detail.chain,
    contract: detail.contract,
    symbol: detail.symbol,
    name: detail.name,
    image: detail.image,
    priceChange24h: detail.priceChange24h,
    currentPriceUsd: detail.currentPriceUsd,
    holders: null,
    totalSupply: null,
    liquidityUsd: null,
    top10HolderPercent: null,
    devHolderPercent: null,
    lockLpPercent: null,
    about: null,
    fdv: null,
    volume24h: detail.volume24h,
  };
}

export async function resolveTokenDetail(
  env: Bindings,
  chain: string,
  contract: string,
): Promise<ResolvedTokenDetail | null> {
  const items = await resolveTokenDetails(env, [{ chain, contract }]);
  return items[0]?.detail ?? null;
}

export async function resolveTokenDetails(
  env: Bindings,
  requests: Array<{ chain: string; contract: string }>,
): Promise<ResolvedTokenDetailBatchItem[]> {
  const normalizedRequests = requests
    .map((item) => normalizeTokenDetailLookup(item))
    .filter((item): item is NormalizedTokenDetailLookup => item != null);
  if (normalizedRequests.length === 0) return [];

  const uniqueLookups = [...new Map(normalizedRequests.map((item) => [item.cacheKey, item])).values()];
  const detailByCacheKey = new Map<string, ResolvedTokenDetail | null>();

  const bitgetDetails = await fetchBitgetTokenDetails(
    env,
    uniqueLookups.map((item) => ({
      chain: item.chain,
      contract: item.contract,
    })),
  ).catch(() => []);
  const bitgetDetailByCacheKey = new Map(bitgetDetails.map((item) => [item.key, item.detail] as const));

  await Promise.all(uniqueLookups.map(async (lookup) => {
    const bitgetDetail = bitgetDetailByCacheKey.get(lookup.cacheKey) ?? null;
    if (bitgetDetail) {
      detailByCacheKey.set(lookup.cacheKey, await enrichBaseTokenDetail(env, bitgetDetail));
      return;
    }

    const binanceFallback = await buildBinanceTokenDetailFallback(lookup.chain, lookup.contract);
    if (binanceFallback) {
      detailByCacheKey.set(
        lookup.cacheKey,
        await enrichBaseTokenDetail(env, binanceFallback.detail, {
          binanceMeta: binanceFallback.meta,
          binanceDynamic: binanceFallback.dynamic,
        }),
      );
      return;
    }

    const d1Fallback = await buildD1TokenDetailFallback(env, lookup.chain, lookup.contract);
    if (d1Fallback) {
      detailByCacheKey.set(lookup.cacheKey, d1Fallback);
      return;
    }

    detailByCacheKey.set(lookup.cacheKey, null);
  }));

  return normalizedRequests.map((item) => ({
    key: item.cacheKey,
    chain: item.chain,
    contract: item.contract === NATIVE_CONTRACT_KEY ? '' : item.contract,
    detail: detailByCacheKey.get(item.cacheKey) ?? null,
  }));
}
