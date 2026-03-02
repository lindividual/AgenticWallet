import type { Bindings } from '../types';
import type { MarketTopAsset, TopAssetListName } from './bitgetWallet';
import { fetchTopMarketAssets, type TopAssetSource } from './marketTopAssets';
import { getSupportedMarketChains } from '../config/appConfig';

type MarketShelfRow = {
  id: string;
  title: string;
  description: string | null;
  source: string;
  list_name: string;
  chains_json: string | null;
  category: string | null;
  limit_count: number | null;
  sort_order: number | null;
  enabled: number | null;
};

export type MarketShelf = {
  id: string;
  title: string;
  description: string | null;
  source: TopAssetSource;
  name: TopAssetListName;
  chains: string[];
  category: string | null;
  assets: MarketTopAsset[];
};

type MarketShelfConfig = Omit<MarketShelf, 'assets'> & {
  limit: number;
  sortOrder: number;
  enabled: boolean;
};

const MARKET_SHELVES_CACHE_TTL_MS = 20_000;
const marketShelvesValueCache = new Map<string, { expiresAt: number; shelves: MarketShelf[] }>();
const marketShelvesInFlightCache = new Map<string, Promise<MarketShelf[]>>();

const DEFAULT_SHELF_CONFIGS: MarketShelfConfig[] = [
  {
    id: 'meme_trending_global',
    title: 'Meme Trending',
    description: 'Global meme momentum shelf',
    source: 'auto',
    name: 'topGainers',
    chains: ['eth', 'base', 'bnb'],
    category: 'meme-token',
    limit: 12,
    sortOrder: 10,
    enabled: true,
  },
  {
    id: 'meme_trending_base',
    title: 'Base Meme',
    description: 'Meme tokens trending on Base',
    source: 'auto',
    name: 'topGainers',
    chains: ['base'],
    category: 'meme-token',
    limit: 10,
    sortOrder: 20,
    enabled: true,
  },
  {
    id: 'meme_trending_bnb',
    title: 'BNB Meme',
    description: 'Meme tokens trending on BNB Chain',
    source: 'auto',
    name: 'topGainers',
    chains: ['bnb'],
    category: 'meme-token',
    limit: 10,
    sortOrder: 30,
    enabled: true,
  },
  {
    id: 'defi_bluechips',
    title: 'DeFi Bluechips',
    description: 'Large-cap DeFi names by market cap',
    source: 'auto',
    name: 'marketCap',
    chains: ['eth', 'base', 'bnb'],
    category: 'decentralized-finance-defi',
    limit: 12,
    sortOrder: 40,
    enabled: true,
  },
  {
    id: 'defi_momentum',
    title: 'DeFi Momentum',
    description: '24h DeFi movers',
    source: 'auto',
    name: 'topGainers',
    chains: ['eth', 'base', 'bnb'],
    category: 'decentralized-finance-defi',
    limit: 12,
    sortOrder: 50,
    enabled: true,
  },
  {
    id: 'market_cap_leaders',
    title: 'Market Cap Leaders',
    description: 'Top assets by market cap',
    source: 'auto',
    name: 'marketCap',
    chains: ['eth', 'base', 'bnb'],
    category: null,
    limit: 12,
    sortOrder: 60,
    enabled: true,
  },
];

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeShelfSource(raw: unknown): TopAssetSource {
  const value = normalizeText(raw)?.toLowerCase();
  if (value === 'coingecko') return 'coingecko';
  if (value === 'bitget') return 'bitget';
  return 'auto';
}

function normalizeShelfName(raw: unknown): TopAssetListName {
  const value = normalizeText(raw)?.toLowerCase();
  if (value === 'toplosers') return 'topLosers';
  if (value === 'topvolume') return 'topVolume';
  if (value === 'marketcap') return 'marketCap';
  if (value === 'trending') return 'trending';
  return 'topGainers';
}

function normalizeChains(raw: unknown): string[] {
  const parsed = typeof raw === 'string' ? raw : '';
  try {
    const value = JSON.parse(parsed) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => normalizeText(item)?.toLowerCase())
      .filter((item): item is string => Boolean(item));
  } catch {
    return [];
  }
}

function parseShelfConfig(row: MarketShelfRow): MarketShelfConfig | null {
  const id = normalizeText(row.id);
  const title = normalizeText(row.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    description: normalizeText(row.description),
    source: normalizeShelfSource(row.source),
    name: normalizeShelfName(row.list_name),
    chains: normalizeChains(row.chains_json),
    category: normalizeText(row.category),
    limit: clampInt(Number(row.limit_count ?? 12), 1, 30),
    sortOrder: clampInt(Number(row.sort_order ?? 999), 1, 9999),
    enabled: Number(row.enabled ?? 1) !== 0,
  };
}

async function loadShelfConfigs(env: Bindings): Promise<MarketShelfConfig[]> {
  try {
    const result = await env.DB.prepare(
      `SELECT id, title, description, source, list_name, chains_json, category, limit_count, sort_order, enabled
       FROM market_shelf_configs
       WHERE enabled = 1
       ORDER BY sort_order ASC, id ASC`,
    ).all<MarketShelfRow>();
    const rows = result.results ?? [];
    const parsed = rows
      .map((row) => parseShelfConfig(row))
      .filter((row): row is MarketShelfConfig => row != null && row.enabled);
    if (parsed.length > 0) return parsed;
  } catch {
    // Fallback when migration is not applied yet.
  }

  return [...DEFAULT_SHELF_CONFIGS].sort((a, b) => a.sortOrder - b.sortOrder);
}

function buildShelfCacheKey(
  supportedChains: Set<'eth' | 'base' | 'bnb'>,
  options?: {
    shelfIds?: string[];
    limitPerShelf?: number;
  },
): string {
  const chains = [...supportedChains].sort().join(',');
  const ids = [...new Set((options?.shelfIds ?? []).map((item) => item.trim()).filter(Boolean))]
    .sort()
    .join(',');
  const limit = Number.isFinite(options?.limitPerShelf) ? String(options?.limitPerShelf) : '';
  return `${chains}|${ids}|${limit}`;
}

export async function fetchMarketShelves(
  env: Bindings,
  options?: {
    shelfIds?: string[];
    limitPerShelf?: number;
  },
): Promise<MarketShelf[]> {
  const supportedChains = new Set(getSupportedMarketChains());
  if (supportedChains.size === 0) return [];

  const cacheKey = buildShelfCacheKey(supportedChains, options);
  const cached = marketShelvesValueCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.shelves;
  }
  const inflight = marketShelvesInFlightCache.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const task = (async () => {
    const configs = await loadShelfConfigs(env);
    const idFilter = new Set(
      (options?.shelfIds ?? [])
        .map((item) => item.trim())
        .filter(Boolean),
    );
    const hasFilter = idFilter.size > 0;
    const limitOverride = options?.limitPerShelf;

    const selectedConfigs = configs
      .map((config) => ({
        ...config,
        chains:
          config.chains.length > 0
            ? config.chains.filter((chain) => supportedChains.has(chain as 'eth' | 'base' | 'bnb'))
            : [...supportedChains],
      }))
      .filter((config) => config.chains.length > 0 && (!hasFilter || idFilter.has(config.id)));
    const shelves = await Promise.all(
      selectedConfigs.map(async (config) => {
        const assets = await fetchTopMarketAssets(env, {
          source: config.source,
          name: config.name,
          chains: config.chains,
          category: config.category ?? undefined,
          limit: clampInt(limitOverride ?? config.limit, 1, 30),
        }).catch((error) => {
          console.warn('[market/shelves] shelf_fetch_failed', {
            shelfId: config.id,
            source: config.source,
            name: config.name,
            chains: config.chains.join(','),
            category: config.category ?? null,
            message: error instanceof Error ? error.message : 'unknown_error',
          });
          return [] as MarketTopAsset[];
        });

        return {
          id: config.id,
          title: config.title,
          description: config.description,
          source: config.source,
          name: config.name,
          chains: config.chains,
          category: config.category,
          assets,
        } satisfies MarketShelf;
      }),
    );
    marketShelvesValueCache.set(cacheKey, {
      expiresAt: Date.now() + MARKET_SHELVES_CACHE_TTL_MS,
      shelves,
    });
    return shelves;
  })().finally(() => {
    marketShelvesInFlightCache.delete(cacheKey);
  });

  marketShelvesInFlightCache.set(cacheKey, task);
  return task;
}
