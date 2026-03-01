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
};

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
    const key = `${asset.chain}:${asset.contract.toLowerCase()}:${asset.symbol.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(asset);
  }
  return output;
}

export async function fetchTopMarketAssets(env: Bindings, options?: FetchTopAssetOptions): Promise<MarketTopAsset[]> {
  const source = options?.source ?? 'auto';
  const limit = options?.limit;
  const name = options?.name;
  const chains = options?.chains;

  if (source === 'bitget') {
    return fetchBitgetTopMarketAssets(env, { name, limit, chains });
  }

  if (source === 'coingecko') {
    const coingeckoAssets = await fetchCoinGeckoTopMarketAssets(env, { name, limit, chains });
    if (coingeckoAssets.length > 0) return coingeckoAssets;
    return fetchBitgetTopMarketAssets(env, { name, limit, chains });
  }

  let coingeckoError: Error | null = null;
  let coingeckoAssets: MarketTopAsset[] = [];
  try {
    coingeckoAssets = await fetchCoinGeckoTopMarketAssets(env, { name, limit, chains });
  } catch (error) {
    coingeckoError = error instanceof Error ? error : new Error('coingecko_fetch_failed');
  }

  if (coingeckoAssets.length >= Math.min(limit ?? 30, 8)) {
    return coingeckoAssets;
  }

  const bitgetAssets = await fetchBitgetTopMarketAssets(env, { name, limit, chains });
  const merged = dedupeAssets([...coingeckoAssets, ...bitgetAssets]);
  if (merged.length > 0) {
    return merged.slice(0, limit ?? 30);
  }

  if (coingeckoError) throw coingeckoError;
  return [];
}
