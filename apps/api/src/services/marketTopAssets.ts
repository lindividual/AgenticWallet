import type { Bindings } from '../types';
import {
  fetchBitgetTopMarketAssets,
  type MarketTopAsset,
  type TopAssetListName,
} from './bitgetWallet';
import { buildChainAssetId } from './assetIdentity';
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
const TOKEN_ICON_LOOKUP_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TOKEN_ICON_LOOKUP_LIMIT = 200;
const tokenIconLookupValueCache = new Map<string, { expiresAt: number; lookup: TokenIconLookup }>();
const tokenIconLookupInFlightCache = new Map<string, Promise<TokenIconLookup>>();

export type TokenIconLookup = {
  byContract: Map<string, string>;
  bySymbol: Map<string, string>;
  byName: Map<string, string>;
};

export type TokenIconInput = {
  chain?: string | null;
  contract?: string | null;
  symbol?: string | null;
  name?: string | null;
};

type TokenIconLookupOptions = {
  source?: TopAssetSource;
  name?: TopAssetListName;
  limit?: number;
  chains?: string[];
  categories?: string[];
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeContractAddress(raw: unknown): string | null {
  const value = normalizeText(raw)?.toLowerCase();
  if (!value) return null;
  if (!/^0x[a-f0-9]{40}$/.test(value)) return null;
  return value;
}

function normalizeSymbolKey(raw: unknown): string | null {
  const value = normalizeText(raw)?.toUpperCase();
  if (!value) return null;
  const key = value.replace(/[^A-Z0-9]+/g, '');
  return key || null;
}

function normalizeNameKey(raw: unknown): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  const key = value
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return key || null;
}

function normalizeCategoryList(raw: string[] | undefined): string[] {
  return [...new Set((raw ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function createEmptyTokenIconLookup(): TokenIconLookup {
  return {
    byContract: new Map<string, string>(),
    bySymbol: new Map<string, string>(),
    byName: new Map<string, string>(),
  };
}

function buildContractLookupKey(chainRaw: unknown, contractRaw: unknown): string | null {
  const chain = normalizeText(chainRaw)?.toLowerCase();
  const contract = normalizeContractAddress(contractRaw);
  if (!chain || !contract) return null;
  return `${chain}:${contract}`;
}

function appendAssetIcon(lookup: TokenIconLookup, asset: MarketTopAsset): void {
  const image = normalizeText(asset.image);
  if (!image) return;

  const contractKey = buildContractLookupKey(asset.chain, asset.contract);
  if (contractKey && !lookup.byContract.has(contractKey)) {
    lookup.byContract.set(contractKey, image);
  }

  const symbolKey = normalizeSymbolKey(asset.symbol);
  if (symbolKey && !lookup.bySymbol.has(symbolKey)) {
    lookup.bySymbol.set(symbolKey, image);
  }

  const nameKey = normalizeNameKey(asset.name);
  if (nameKey && !lookup.byName.has(nameKey)) {
    lookup.byName.set(nameKey, image);
  }
}

function normalizeTokenIconLookupOptions(
  options?: TokenIconLookupOptions,
): Required<Pick<TokenIconLookupOptions, 'source' | 'name' | 'limit'>> & {
  chains: string[];
  categories: string[];
} {
  const source = options?.source ?? 'auto';
  const name = options?.name ?? 'marketCap';
  const limit = clampInt(options?.limit ?? DEFAULT_TOKEN_ICON_LOOKUP_LIMIT, 20, 400);
  const chains = [...new Set((options?.chains ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const categories = normalizeCategoryList(options?.categories);
  return {
    source,
    name,
    limit,
    chains,
    categories,
  };
}

function buildTokenIconLookupCacheKey(options: ReturnType<typeof normalizeTokenIconLookupOptions>): string {
  return `${options.source}|${options.name}|${options.limit}|${options.chains.join(',')}|${options.categories.join(',')}`;
}

export async function loadTokenIconLookup(
  env: Bindings,
  options?: TokenIconLookupOptions,
): Promise<TokenIconLookup> {
  const normalized = normalizeTokenIconLookupOptions(options);
  const cacheKey = buildTokenIconLookupCacheKey(normalized);
  const now = Date.now();
  const cached = tokenIconLookupValueCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.lookup;
  }

  const inFlight = tokenIconLookupInFlightCache.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const lookup = createEmptyTokenIconLookup();
    const baseAssets = await fetchTopMarketAssets(env, {
      source: normalized.source,
      name: normalized.name,
      limit: normalized.limit,
      chains: normalized.chains,
    }).catch(() => []);
    for (const asset of baseAssets) {
      appendAssetIcon(lookup, asset);
    }

    for (const category of normalized.categories) {
      const categorizedAssets = await fetchTopMarketAssets(env, {
        source: 'coingecko',
        name: normalized.name,
        limit: normalized.limit,
        chains: normalized.chains,
        category,
      }).catch(() => []);
      for (const asset of categorizedAssets) {
        appendAssetIcon(lookup, asset);
      }
    }

    tokenIconLookupValueCache.set(cacheKey, {
      expiresAt: Date.now() + TOKEN_ICON_LOOKUP_CACHE_TTL_MS,
      lookup,
    });
    return lookup;
  })().finally(() => {
    tokenIconLookupInFlightCache.delete(cacheKey);
  });

  tokenIconLookupInFlightCache.set(cacheKey, task);
  return task;
}

export function resolveTokenIconFromLookup(
  lookup: TokenIconLookup,
  input: TokenIconInput,
): string | null {
  const contractKey = buildContractLookupKey(input.chain, input.contract);
  if (contractKey) {
    const icon = lookup.byContract.get(contractKey);
    if (icon) return icon;
  }

  const symbolKey = normalizeSymbolKey(input.symbol);
  if (symbolKey) {
    const icon = lookup.bySymbol.get(symbolKey);
    if (icon) return icon;
  }

  const nameKey = normalizeNameKey(input.name);
  if (nameKey) {
    const icon = lookup.byName.get(nameKey);
    if (icon) return icon;
  }

  return null;
}

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
    const key = asset.chain_asset_id || buildChainAssetId(asset.chain, asset.contract);
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
    // Prefer Bitget entry on duplicate assets so its icon wins when available.
    const merged = dedupeAssets([...bitgetAssets, ...coingeckoAssets]);
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
