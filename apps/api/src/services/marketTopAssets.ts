import type { Bindings } from '../types';
import {
  fetchBitgetTopMarketAssets,
  type MarketTopAsset,
  type TopAssetListName,
} from './bitgetWallet';
import { fetchCoinGeckoTopMarketAssets } from './coingecko';

export type TopAssetSource = 'auto' | 'coingecko' | 'bitget';

type FetchTopAssetOptions = {
  source?: TopAssetSource;
  name?: TopAssetListName;
  limit?: number;
  chains?: string[];
  category?: string;
};

const TOP_ASSETS_CACHE_TTL_MS = 20_000;
const topAssetsValueCache = new Map<string, { expiresAt: number; assets: MarketTopAsset[] }>();
const topAssetsInFlightCache = new Map<string, Promise<MarketTopAsset[]>>();

function supportsBitgetListName(name: TopAssetListName | undefined): boolean {
  return name === 'topGainers' || name === 'topLosers' || name == null;
}

export function normalizeTopAssetSource(raw: string | null | undefined): TopAssetSource {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'coingecko') return 'coingecko';
  if (value === 'bitget') return 'bitget';
  return 'auto';
}

export function normalizeTopAssetListName(raw: string | null | undefined): TopAssetListName {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'toplosers') return 'topLosers';
  if (value === 'topvolume') return 'topVolume';
  if (value === 'marketcap') return 'marketCap';
  if (value === 'trending') return 'trending';
  return 'topGainers';
}

function dedupeAssets(assets: MarketTopAsset[]): MarketTopAsset[] {
  const output: MarketTopAsset[] = [];
  const seen = new Set<string>();
  for (const asset of assets) {
    const key = asset.chain_asset_id || `${asset.chain}:${asset.contract.toLowerCase()}:${asset.symbol.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(asset);
  }
  return output;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeFetchOptions(options?: FetchTopAssetOptions): Required<Pick<FetchTopAssetOptions, 'source' | 'name' | 'limit'>> & {
  chains: string[];
  category: string | null;
} {
  const source = options?.source ?? 'auto';
  const name = options?.name ?? 'topGainers';
  const limit = clampInt(options?.limit ?? 30, 1, 100);
  const chains = [...new Set((options?.chains ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const category = (options?.category ?? '').trim().toLowerCase() || null;
  return {
    source,
    name,
    limit,
    chains,
    category,
  };
}

function buildTopAssetsCacheKey(options: ReturnType<typeof normalizeFetchOptions>): string {
  return `${options.source}|${options.name}|${options.limit}|${options.chains.join(',')}|${options.category ?? ''}`;
}

export async function fetchTopMarketAssets(env: Bindings, options?: FetchTopAssetOptions): Promise<MarketTopAsset[]> {
  const normalized = normalizeFetchOptions(options);
  const cacheKey = buildTopAssetsCacheKey(normalized);
  const now = Date.now();
  const cached = topAssetsValueCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.assets;
  }

  const inFlight = topAssetsInFlightCache.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const source = normalized.source;
    const limit = normalized.limit;
    const name = normalized.name;
    const chains = normalized.chains;
    const category = normalized.category ?? undefined;

    if (source === 'bitget') {
      if (!supportsBitgetListName(name)) {
        throw new Error(`bitget_unsupported_list_name:${name}`);
      }
      const assets = await fetchBitgetTopMarketAssets(env, { name, limit, chains });
      topAssetsValueCache.set(cacheKey, {
        expiresAt: Date.now() + TOP_ASSETS_CACHE_TTL_MS,
        assets,
      });
      return assets;
    }

    if (source === 'coingecko') {
      const coingeckoAssets = await fetchCoinGeckoTopMarketAssets(env, { name, limit, chains, category });
      if (coingeckoAssets.length > 0) {
        topAssetsValueCache.set(cacheKey, {
          expiresAt: Date.now() + TOP_ASSETS_CACHE_TTL_MS,
          assets: coingeckoAssets,
        });
        return coingeckoAssets;
      }
      if (!supportsBitgetListName(name)) return [];
      const assets = await fetchBitgetTopMarketAssets(env, { name, limit, chains });
      topAssetsValueCache.set(cacheKey, {
        expiresAt: Date.now() + TOP_ASSETS_CACHE_TTL_MS,
        assets,
      });
      return assets;
    }

    let coingeckoError: Error | null = null;
    let coingeckoAssets: MarketTopAsset[] = [];
    try {
      coingeckoAssets = await fetchCoinGeckoTopMarketAssets(env, { name, limit, chains, category });
    } catch (error) {
      coingeckoError = error instanceof Error ? error : new Error('coingecko_fetch_failed');
    }

    if (coingeckoAssets.length >= Math.min(limit, 8)) {
      topAssetsValueCache.set(cacheKey, {
        expiresAt: Date.now() + TOP_ASSETS_CACHE_TTL_MS,
        assets: coingeckoAssets,
      });
      return coingeckoAssets;
    }

    if (!supportsBitgetListName(name)) {
      const assets = coingeckoAssets.length > 0 ? coingeckoAssets.slice(0, limit) : [];
      if (assets.length > 0) {
        topAssetsValueCache.set(cacheKey, {
          expiresAt: Date.now() + TOP_ASSETS_CACHE_TTL_MS,
          assets,
        });
        return assets;
      }
      if (coingeckoError) throw coingeckoError;
      return [];
    }

    const bitgetAssets = await fetchBitgetTopMarketAssets(env, { name, limit, chains });
    const merged = dedupeAssets([...coingeckoAssets, ...bitgetAssets]);
    if (merged.length > 0) {
      const assets = merged.slice(0, limit);
      topAssetsValueCache.set(cacheKey, {
        expiresAt: Date.now() + TOP_ASSETS_CACHE_TTL_MS,
        assets,
      });
      return assets;
    }

    if (coingeckoError) throw coingeckoError;
    return [];
  })().finally(() => {
    topAssetsInFlightCache.delete(cacheKey);
  });

  topAssetsInFlightCache.set(cacheKey, task);
  return task;
}
