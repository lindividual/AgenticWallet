import type { CoinDetailBatchItem } from '../api';
import { buildChainAssetId } from './assetIdentity';
import { cacheStores, readCache, writeCache } from './indexedDbCache';

const TRACKED_ASSET_DETAIL_CACHE_TTL_MS = 30 * 60 * 1000;

function buildTrackedAssetDetailCacheKey(chain: string, contract: string): string {
  return `wallet-tracked-asset-detail:v1:${buildChainAssetId(chain, contract).trim()}`;
}

export async function readTrackedAssetDetailCache(
  tokens: Array<{ chain: string; contract: string }>,
): Promise<CoinDetailBatchItem[]> {
  const results = await Promise.all(
    tokens.map(async ({ chain, contract }) => {
      const cached = await readCache<CoinDetailBatchItem>(
        cacheStores.query,
        buildTrackedAssetDetailCacheKey(chain, contract),
      );
      return cached;
    }),
  );
  return results.filter((item): item is CoinDetailBatchItem => Boolean(item));
}

export async function writeTrackedAssetDetailCache(items: CoinDetailBatchItem[]): Promise<void> {
  await Promise.all(
    items.map((item) =>
      writeCache<CoinDetailBatchItem>(
        cacheStores.query,
        buildTrackedAssetDetailCacheKey(item.chain, item.contract),
        item,
        TRACKED_ASSET_DETAIL_CACHE_TTL_MS,
      ),
    ),
  );
}
