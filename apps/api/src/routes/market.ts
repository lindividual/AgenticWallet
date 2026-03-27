import type { Hono } from 'hono';
import { getSupportedMarketChains } from '../config/appConfig';
import type { AppEnv } from '../types';
import type { BitgetTokenSecurityAudit, MarketTopAsset } from '../services/bitgetWallet';
import {
  fetchBitgetTokenKline,
  fetchBitgetTokenSecurityAudit,
} from '../services/bitgetWallet';
import {
  fetchBinanceWeb3TokenKlines,
  resolveBinanceSearchChainIds,
  searchBinanceSpotTokens,
} from '../services/binance';
import {
  getCoinGeckoCoinListSyncStatus,
  resolveCoinGeckoAssetIdForContract,
  syncCoinGeckoCoinListPlatforms,
} from '../services/coingecko';
import { resolveTokenDetail, resolveTokenDetails } from '../services/tokenDetails';
import {
  getUserTradeShelf,
  listUserWatchlistAssets,
  refreshUserTradeShelf,
  removeUserWatchlistAsset,
  upsertUserWatchlistAsset,
} from '../services/agent';
import { fetchTopMarketAssets } from '../services/marketTopAssets';
import {
  buildSearchTerms,
  fetchPredictionEventDetail,
  fetchPredictionEventSeries,
  fetchTradeBrowse,
  fetchTradeMarketDetail,
  fetchTradeMarketKline,
  scoreSearchMatch,
  searchPerpMarkets,
  searchPredictionMarkets,
  type TradeBrowseMarketItem,
  type TradeBrowsePredictionItem,
} from '../services/tradeBrowse';
import { buildChainAssetId, NATIVE_CONTRACT_KEY, normalizeMarketChain, toContractKey } from '../services/assetIdentity';
import { isKlineStale, shouldPreferFallbackCandles } from '../services/klineFreshness';

type MarketSearchResultItem = {
  id: string;
  marketType: 'spot' | 'perp' | 'prediction';
  symbol: string;
  name: string;
  image: string | null;
  currentPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
  probability: number | null;
  source: string;
  externalUrl: string | null;
  itemId: string | null;
  chain: string | null;
  contract: string | null;
  asset_id?: string;
};

type SearchCandidate = {
  item: MarketSearchResultItem;
  score: number;
};

const NATIVE_COIN_ASSET_ID_BY_CHAIN: Record<string, string> = {
  eth: 'coingecko:ethereum',
  base: 'coingecko:ethereum',
  bnb: 'coingecko:binancecoin',
  tron: 'coingecko:tron',
  sol: 'coingecko:solana',
  btc: 'coingecko:bitcoin',
};

const NATIVE_MAJOR_SEARCH_ITEMS = [
  { symbol: 'BTC', name: 'Bitcoin', chain: 'btc' },
  { symbol: 'ETH', name: 'Ethereum', chain: 'eth' },
  { symbol: 'BNB', name: 'BNB', chain: 'bnb' },
  { symbol: 'TRX', name: 'TRON', chain: 'tron' },
  { symbol: 'SOL', name: 'Solana', chain: 'sol' },
] as const;

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeContractQuery(chain: string, raw: unknown): string {
  return toContractKey(normalizeText(raw) ?? NATIVE_CONTRACT_KEY, chain);
}

function toResponseContract(chain: string, contract: string): string {
  return toContractKey(contract, chain) === NATIVE_CONTRACT_KEY ? '' : contract;
}

function toValidSize(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(10, Math.min(Math.trunc(value), 240));
}

function buildCoinLookupKey(chain: string, contract: string): string {
  return `${normalizeMarketChain(chain)}:${toContractKey(contract, chain)}`;
}

async function resolveCoinAssetId(env: AppEnv['Bindings'], chain: string, contract: string): Promise<string> {
  const normalizedChain = normalizeMarketChain(chain);
  const contractKey = toContractKey(contract, normalizedChain);
  if (contractKey === NATIVE_CONTRACT_KEY) {
    return NATIVE_COIN_ASSET_ID_BY_CHAIN[normalizedChain] ?? `chain:${normalizedChain}:${NATIVE_CONTRACT_KEY}`;
  }

  const resolved = await resolveCoinGeckoAssetIdForContract(env, normalizedChain, contractKey).catch(() => null);
  return resolved ?? `chain:${normalizedChain}:${contractKey}`;
}

async function buildCoinAssetIdMap(
  env: AppEnv['Bindings'],
  refs: Array<{ chain: string | null | undefined; contract: string | null | undefined }>,
): Promise<Map<string, string>> {
  const keys = new Map<string, { chain: string; contract: string }>();
  for (const ref of refs) {
    const chain = normalizeText(ref.chain);
    if (!chain) continue;
    const normalizedChain = normalizeMarketChain(chain);
    const contract = toContractKey(ref.contract ?? NATIVE_CONTRACT_KEY, normalizedChain);
    keys.set(buildCoinLookupKey(normalizedChain, contract), { chain: normalizedChain, contract });
  }

  const entries = [...keys.entries()];
  const values = await Promise.all(entries.map(([, ref]) => resolveCoinAssetId(env, ref.chain, ref.contract)));
  const output = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    output.set(entries[index][0], values[index]);
  }
  return output;
}

function applyCoinIdentityToTradeItem(item: TradeBrowseMarketItem, assetIdMap: Map<string, string>): TradeBrowseMarketItem {
  const chain = normalizeText(item.chain);
  if (!chain) return { ...item, asset_id: undefined };
  const contractKey = toContractKey(item.contract ?? NATIVE_CONTRACT_KEY, chain);
  return {
    ...item,
    asset_id: assetIdMap.get(buildCoinLookupKey(chain, contractKey)),
  };
}

function stripLegacyIds<T extends { asset_id?: string }>(item: T): T {
  return {
    ...item,
    asset_id: undefined,
  };
}

function buildNativeMajorSearchResults(query: string): MarketSearchResultItem[] {
  const terms = buildSearchTerms(query);
  if (!terms.length) return [];
  return NATIVE_MAJOR_SEARCH_ITEMS
    .map((item) => ({
      id: `native:${item.chain}`,
      marketType: 'spot' as const,
      symbol: item.symbol,
      name: item.name,
      image: null,
      currentPrice: null,
      change24h: null,
      volume24h: null,
      probability: null,
      source: 'native_major',
      externalUrl: null,
      itemId: null,
      chain: item.chain,
      contract: '',
    }))
    .filter((item) => scoreSearchMatch(`${item.symbol} ${item.name}`, terms) > 0);
}

function toSpotSearchItem(item: Awaited<ReturnType<typeof searchBinanceSpotTokens>>[number]): MarketSearchResultItem | null {
  return {
    id: item.id,
    marketType: 'spot',
    symbol: item.symbol,
    name: item.name,
    image: item.image,
    currentPrice: item.currentPrice,
    change24h: item.change24h,
    volume24h: item.volume24h,
    probability: null,
    source: 'binance',
    externalUrl: null,
    itemId: null,
    chain: normalizeMarketChain(item.chain),
    contract: item.nativeAddressFlag ? '' : item.contract,
  };
}

async function buildBinanceTokenSearchResults(
  env: AppEnv['Bindings'],
  query: string,
  limit: number,
  options?: {
    chains?: string[];
  },
): Promise<MarketSearchResultItem[]> {
  const rows = await searchBinanceSpotTokens(query, limit, { chains: options?.chains });
  const items = rows
    .map(toSpotSearchItem)
    .filter((item): item is MarketSearchResultItem => item != null);
  return applyCoinIdentityToSearchItems(env, items);
}

async function applyCoinIdentityToSearchItems(
  env: AppEnv['Bindings'],
  items: MarketSearchResultItem[],
): Promise<MarketSearchResultItem[]> {
  const spotItems = items.filter((item) => item.marketType === 'spot');
  const assetIdMap = await buildCoinAssetIdMap(
    env,
    spotItems.map((item) => ({
      chain: item.chain,
      contract: item.contract ?? NATIVE_CONTRACT_KEY,
    })),
  );
  return items.map((item) => {
    if (item.marketType !== 'spot') return item;
    const chain = normalizeText(item.chain);
    if (!chain) return item;
    const contractKey = toContractKey(item.contract ?? NATIVE_CONTRACT_KEY, chain);
    return {
      ...item,
      asset_id: assetIdMap.get(buildCoinLookupKey(chain, contractKey)),
    };
  });
}

function toTopAssetResponse(asset: MarketTopAsset, assetIdMap: Map<string, string>): MarketTopAsset {
  const key = buildCoinLookupKey(asset.chain, asset.contract || NATIVE_CONTRACT_KEY);
  return {
    ...asset,
    asset_id: assetIdMap.get(key) ?? asset.asset_id,
  };
}

function toTokenSecurityResponse(audit: BitgetTokenSecurityAudit, assetId: string) {
  return {
    ...audit,
    asset_id: assetId,
    chain_asset_id: buildChainAssetId(audit.chain, audit.contract || NATIVE_CONTRACT_KEY),
    contract: toResponseContract(audit.chain, audit.contract || NATIVE_CONTRACT_KEY),
  };
}

export function registerMarketRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/market/top-assets', async (c) => {
    const limit = toValidSize(c.req.query('limit'), 30);
    const name = normalizeText(c.req.query('name')) ?? 'topGainers';
    const source = normalizeText(c.req.query('source')) ?? 'auto';
    const chains = (normalizeText(c.req.query('chains')) ?? '')
      .split(',')
      .map((item) => normalizeMarketChain(item))
      .filter(Boolean);
    const category = normalizeText(c.req.query('category')) ?? undefined;

    const assets = await fetchTopMarketAssets(c.env, {
      limit,
      name: name as 'topGainers' | 'topLosers' | 'topVolume' | 'marketCap' | 'trending',
      source: source as 'auto' | 'coingecko' | 'bitget',
      chains,
      category,
    });
    const assetIdMap = await buildCoinAssetIdMap(
      c.env,
      assets.map((asset) => ({ chain: asset.chain, contract: asset.contract })),
    );
    return c.json({ assets: assets.map((asset) => toTopAssetResponse(asset, assetIdMap)) });
  });

  app.get('/v1/market/trade-browse', async (c) => {
    const browse = await fetchTradeBrowse(c.env, {
      scheduleBackgroundTask: (task) => c.executionCtx.waitUntil(task),
    });
    const assetIdMap = await buildCoinAssetIdMap(
      c.env,
      [...browse.topMovers, ...browse.trendings].map((item) => ({
        chain: item.chain,
        contract: item.contract ?? NATIVE_CONTRACT_KEY,
      })),
    );
    return c.json({
      generatedAt: browse.generatedAt,
      topMovers: browse.topMovers.map((item) => applyCoinIdentityToTradeItem(item, assetIdMap)),
      trendings: browse.trendings.map((item) => applyCoinIdentityToTradeItem(item, assetIdMap)),
      perps: browse.perps.map(stripLegacyIds),
      predictions: browse.predictions.map(stripLegacyIds),
    });
  });

  app.get('/v1/market/trade-shelf', async (c) => {
    const userId = c.get('userId');

    try {
      let shelf = await getUserTradeShelf(c.env, userId);
      const hasCachedSections = shelf.sections.some((section) => section.items.length > 0);

      if (!hasCachedSections) {
        const refreshed = await refreshUserTradeShelf(c.env, userId, { force: true });
        shelf = refreshed.shelf;
      } else if (shelf.refreshState.needsRefresh) {
        c.executionCtx.waitUntil(
          refreshUserTradeShelf(c.env, userId).catch(() => undefined),
        );
      }

      return c.json(shelf);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'trade_shelf_failed';
      return c.json({ error: message }, 502);
    }
  });

  app.get('/v1/market/trade-detail', async (c) => {
    const type = normalizeText(c.req.query('type')) ?? '';
    const id = normalizeText(c.req.query('id')) ?? '';
    if (!id || (type !== 'perp' && type !== 'prediction')) {
      return c.json({ error: 'invalid_trade_market_query' }, 400);
    }

    const detail = await fetchTradeMarketDetail(c.env, {
      type: type as 'perp' | 'prediction',
      id,
    });
    if (!detail) {
      return c.json({ error: 'trade_market_not_found' }, 404);
    }
    return c.json({ detail: stripLegacyIds(detail) });
  });

  app.get('/v1/market/trade-kline', async (c) => {
    const type = normalizeText(c.req.query('type')) ?? '';
    const id = normalizeText(c.req.query('id')) ?? '';
    if (!id || (type !== 'perp' && type !== 'prediction')) {
      return c.json({ error: 'invalid_trade_market_query' }, 400);
    }
    const period = normalizeText(c.req.query('period')) ?? '1h';
    const size = toValidSize(c.req.query('size'), 60);
    const optionTokenId = normalizeText(c.req.query('optionTokenId'));
    const candles = await fetchTradeMarketKline(c.env, {
      type: type as 'perp' | 'prediction',
      id,
      period,
      size,
      optionTokenId,
    });
    return c.json({ candles });
  });

  app.get('/v1/market/prediction-detail', async (c) => {
    const id = normalizeText(c.req.query('id')) ?? '';
    if (!id) return c.json({ error: 'invalid_prediction_id' }, 400);
    const detail = await fetchPredictionEventDetail(c.env, id);
    if (!detail) return c.json({ error: 'prediction_not_found' }, 404);
    return c.json({ detail });
  });

  app.get('/v1/market/prediction-kline', async (c) => {
    const id = normalizeText(c.req.query('id')) ?? '';
    if (!id) return c.json({ error: 'invalid_prediction_id' }, 400);
    const period = normalizeText(c.req.query('period')) ?? 'all';
    const size = toValidSize(c.req.query('size'), 240);
    const series = await fetchPredictionEventSeries(c.env, id, period, size);
    return c.json({ series });
  });

  app.get('/v1/market/watchlist', async (c) => {
    const userId = c.get('userId');
    const limit = toValidSize(c.req.query('limit'), 200);
    const assets = await listUserWatchlistAssets(c.env, userId, limit);
    return c.json({ assets });
  });

  app.post('/v1/market/watchlist', async (c) => {
    const userId = c.get('userId');
    const body = await c.req
      .json<{
        watchType?: string;
        itemId?: string | null;
        chain?: string | null;
        contract?: string | null;
        symbol?: string | null;
        name?: string | null;
        image?: string | null;
        source?: string | null;
        change24h?: number | null;
        externalUrl?: string | null;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: 'invalid_watchlist_payload' }, 400);

    try {
      const asset = await upsertUserWatchlistAsset(c.env, userId, body);
      return c.json({ ok: true, asset });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'watchlist_upsert_failed';
      const status = message.startsWith('invalid_') ? 400 : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post('/v1/market/watchlist/remove', async (c) => {
    const userId = c.get('userId');
    const body = await c.req
      .json<{
        id?: string | null;
        chain?: string | null;
        contract?: string | null;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: 'invalid_watchlist_payload' }, 400);

    try {
      const removed = await removeUserWatchlistAsset(c.env, userId, body);
      return c.json({ ok: true, removed });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'watchlist_remove_failed';
      const status = message === 'invalid_watchlist_remove_target' ? 400 : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post('/v1/market/coingecko/platforms/sync', async (c) => {
    const force = (c.req.query('force') ?? '').trim().toLowerCase() === 'true';
    try {
      const result = await syncCoinGeckoCoinListPlatforms(c.env, { force });
      return c.json(result);
    } catch (error) {
      return c.json(
        {
          error: 'coingecko_platform_sync_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/coingecko/platforms/sync-status', async (c) => {
    const status = await getCoinGeckoCoinListSyncStatus(c.env);
    return c.json(status);
  });

  app.get('/v1/market/token-detail', async (c) => {
    const chain = normalizeMarketChain(c.req.query('chain'));
    const contract = normalizeContractQuery(chain, c.req.query('contract'));
    if (!chain || chain === 'unknown') {
      return c.json({ error: 'invalid_chain' }, 400);
    }

    const detail = await resolveTokenDetail(c.env, chain, contract);
    if (!detail) {
      return c.json({ error: 'token_not_found' }, 404);
    }
    return c.json({ detail });
  });

  app.get('/v1/market/token-security', async (c) => {
    const chain = normalizeMarketChain(c.req.query('chain'));
    const contract = normalizeContractQuery(chain, c.req.query('contract'));
    if (!chain || chain === 'unknown') {
      return c.json({ error: 'invalid_chain' }, 400);
    }

    const audit = await fetchBitgetTokenSecurityAudit(c.env, chain, contract);
    if (!audit) {
      return c.json({ audit: null });
    }

    const assetId = await resolveCoinAssetId(c.env, chain, contract);
    return c.json({ audit: toTokenSecurityResponse(audit, assetId) });
  });

  app.post('/v1/market/token-details', async (c) => {
    const body = await c.req.json<{ tokens?: Array<{ chain?: string; contract?: string }> }>().catch(() => null);
    const tokens = (body?.tokens ?? [])
      .map((item) => ({
        chain: normalizeMarketChain(item?.chain),
        contract: normalizeContractQuery(normalizeMarketChain(item?.chain), item?.contract),
      }))
      .filter((item) => Boolean(item.chain) && item.chain !== 'unknown')
      .slice(0, 100);

    if (!tokens.length) {
      return c.json({ error: 'invalid_tokens' }, 400);
    }

    const details = await resolveTokenDetails(c.env, tokens);

    return c.json({ details });
  });

  app.get('/v1/market/kline', async (c) => {
    const chain = normalizeMarketChain(c.req.query('chain'));
    const contract = normalizeContractQuery(chain, c.req.query('contract'));
    const period = normalizeText(c.req.query('period')) ?? '1h';
    const size = toValidSize(c.req.query('size'), 60);
    if (!chain || chain === 'unknown') {
      return c.json({ error: 'invalid_chain' }, 400);
    }

    try {
      const primary = await fetchBitgetTokenKline(c.env, { chain, contract, period, size });
      const fallback = (!primary.length || isKlineStale(primary, period))
        ? await fetchBinanceWeb3TokenKlines(chain, contract, period, size).catch(() => [])
        : [];
      if (fallback.length > 0 && shouldPreferFallbackCandles(primary, fallback, period)) {
        return c.json({ period, candles: fallback, source: 'binance_web3_fallback' });
      }
      return c.json({ period, candles: primary });
    } catch (error) {
      const fallback = await fetchBinanceWeb3TokenKlines(chain, contract, period, size).catch(() => []);
      if (fallback.length > 0) {
        return c.json({ period, candles: fallback, source: 'binance_web3_fallback' });
      }
      const message = error instanceof Error ? error.message : 'unknown_error';
      const status = message.includes('429') ? 429 : 502;
      return c.json({ error: 'token_kline_failed', message }, status);
    }
  });

  app.get('/v1/market/search', async (c) => {
    const q = normalizeText(c.req.query('q')) ?? '';
    const limit = Math.min(toValidSize(c.req.query('limit'), 20), 50);
    if (!q) return c.json({ results: [] });

    const terms = buildSearchTerms(q);
    const candidateLimit = Math.min(Math.max(limit * 3, 18), 60);
    const nativeResults = buildNativeMajorSearchResults(q);
    const [spotResult, perpResult, predictionResult] = await Promise.allSettled([
      searchBinanceSpotTokens(q, candidateLimit),
      searchPerpMarkets(c.env, q, { limit: candidateLimit }),
      searchPredictionMarkets(q, { limit: candidateLimit }),
    ]);

    const candidates: SearchCandidate[] = nativeResults.map((item) => ({
      item,
      score: scoreSearchMatch(`${item.symbol} ${item.name}`, terms) + 20,
    }));

    if (spotResult.status === 'fulfilled') {
      for (const row of spotResult.value) {
        const item = toSpotSearchItem(row);
        if (!item) continue;
        const exactSymbolMatch = item.symbol.trim().toUpperCase() === q.trim().toUpperCase();
        const score = scoreSearchMatch(`${item.symbol} ${item.name}`, terms) + (exactSymbolMatch ? 25 : 0);
        if (score <= 0) continue;
        candidates.push({ item, score });
      }
    }

    if (perpResult.status === 'fulfilled') {
      for (const row of perpResult.value) {
        const score = scoreSearchMatch(`${row.symbol} ${row.name}`, terms) + 10;
        if (score <= 0) continue;
        candidates.push({
          score,
          item: {
            id: row.id,
            marketType: 'perp',
            symbol: row.symbol,
            name: row.name,
            image: row.image,
            currentPrice: row.currentPrice,
            change24h: row.change24h,
            volume24h: row.volume24h,
            probability: null,
            source: row.source,
            externalUrl: row.externalUrl,
            itemId: row.id,
            chain: null,
            contract: null,
          },
        });
      }
    }

    if (predictionResult.status === 'fulfilled') {
      for (const row of predictionResult.value) {
        const score = scoreSearchMatch(row.title, terms);
        if (score <= 0) continue;
        candidates.push({
          score,
          item: {
            id: row.id,
            marketType: 'prediction',
            symbol: 'PM',
            name: row.title,
            image: row.image,
            currentPrice: null,
            change24h: null,
            volume24h: row.volume24h,
            probability: row.probability,
            source: row.source,
            externalUrl: row.url,
            itemId: row.id,
            chain: null,
            contract: null,
          },
        });
      }
    }

    if (!candidates.length) {
      return c.json({ results: [] });
    }

    const withIdentity = await applyCoinIdentityToSearchItems(
      c.env,
      candidates.map((candidate) => candidate.item),
    );
    const withIdentityById = new Map(withIdentity.map((item) => [`${item.marketType}:${item.id}`, item]));
    const dedupe = new Set<string>();

    const results = candidates
      .map((candidate) => ({
        ...candidate,
        item: withIdentityById.get(`${candidate.item.marketType}:${candidate.item.id}`) ?? candidate.item,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return Number(b.item.volume24h ?? 0) - Number(a.item.volume24h ?? 0);
      })
      .filter((candidate) => {
        const item = candidate.item;
        const dedupeKey = item.marketType === 'spot'
          ? `${item.marketType}:${normalizeMarketChain(item.chain)}:${toContractKey(item.contract ?? NATIVE_CONTRACT_KEY, item.chain ?? 'eth')}`
          : `${item.marketType}:${item.itemId ?? item.id}`;
        if (dedupe.has(dedupeKey)) return false;
        dedupe.add(dedupeKey);
        return true;
      })
      .slice(0, limit)
      .map((candidate) => candidate.item);

    return c.json({ results });
  });

  app.get('/v1/market/token-search', async (c) => {
    const q = normalizeText(c.req.query('q')) ?? '';
    const limit = Math.min(toValidSize(c.req.query('limit'), 20), 50);
    if (!q) return c.json({ results: [] });

    const supportedChains = getSupportedMarketChains();
    const supportedBinanceChainIds = resolveBinanceSearchChainIds(supportedChains);
    if (supportedBinanceChainIds.length === 0) {
      return c.json({ results: [] });
    }

    const results = await buildBinanceTokenSearchResults(c.env, q, limit, {
      chains: supportedChains,
    });
    return c.json({ results });
  });

  app.get('/v1/market/sources', (c) => {
    return c.json({
      model: 'coin_perp_prediction_split',
      sources: {
        coin: ['coingecko', 'bitget', 'binance_web3', 'solana_rpc'],
        perp: ['hyperliquid'],
        prediction: ['polymarket'],
      },
    });
  });
}
