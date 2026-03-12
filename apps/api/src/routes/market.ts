import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import type { BitgetTokenDetail, BitgetTokenSecurityAudit, MarketTopAsset } from '../services/bitgetWallet';
import {
  fetchBitgetTokenDetail,
  fetchBitgetTokenDetails,
  fetchBitgetTokenKline,
  fetchBitgetTokenSecurityAudit,
} from '../services/bitgetWallet';
import { getCoinGeckoCoinListSyncStatus, syncCoinGeckoCoinListPlatforms } from '../services/coingecko';
import {
  fetchTopMarketAssets,
  loadTokenIconLookup,
  normalizeTopAssetListName,
  normalizeTopAssetSource,
  resolveTokenIconFromLookup,
} from '../services/marketTopAssets';
import { contractKeyToUpstreamContract, normalizeMarketChain, toContractKey } from '../services/assetIdentity';
import {
  buildSearchTerms,
  fetchPredictionEventDetail,
  fetchPredictionEventSeries,
  fetchTradeBrowse,
  type TradeBrowseMarketItem,
  type TradeBrowsePredictionItem,
  fetchTradeMarketDetail,
  fetchTradeMarketKline,
  normalizeTradeMarketDetailType,
  scoreSearchMatch,
} from '../services/tradeBrowse';
import { fetchBinanceSpotKlines, searchBinanceSpotTokens } from '../services/binance';
import { fetchSolanaTokenDetails } from '../services/solana';
import { listUserWatchlistAssets, removeUserWatchlistAsset, upsertUserWatchlistAsset } from '../services/agent';
import {
  buildLegacyItemIdForInstrument,
  listAssetsByIds,
  parseInstrumentMetadata,
  resolveAssetIdentity,
  resolveAssetIdentityBatch,
  searchStoredMarketRecords,
  type ResolveAssetInput,
  type ResolvedAsset,
} from '../services/assetData';
import { isKlineStale, shouldPreferFallbackCandles } from '../services/klineFreshness';

const TOKENIZED_STOCK_ICON_CATEGORIES = ['tokenized-stock', 'tokenized-stocks'];
const NATIVE_MAJOR_SEARCH_ITEMS = [
  { symbol: 'BNB', name: 'BNB', chain: 'bnb' },
  { symbol: 'ETH', name: 'Ethereum', chain: 'eth' },
  { symbol: 'SOL', name: 'Solana', chain: 'sol' },
] as const;

type SearchMarketType = 'spot' | 'stock' | 'perp' | 'prediction';

type MarketSearchResultItem = {
  id: string;
  marketType: SearchMarketType;
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
  instrument_id?: string;
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function buildMarketSearchResolveRequest(item: MarketSearchResultItem): IdentityResolveRequest | null {
  if (item.marketType === 'spot') {
    const chain = normalizeText(item.chain);
    const contract = normalizeText(item.contract);
    if (!chain || contract == null) return null;
    return {
      key: `search:spot:${normalizeMarketChain(chain)}:${toContractKey(contract)}`,
      input: {
        chain,
        contract,
        marketType: 'spot',
        symbol: item.symbol,
        nameHint: item.name,
      },
    };
  }

  if (item.marketType === 'stock') {
    const itemId = normalizeText(item.itemId);
    if (!itemId) return null;
    return {
      key: `search:stock:${itemId.toLowerCase()}`,
      input: {
        itemId,
        marketType: 'spot',
        assetClassHint: 'equity_exposure',
        symbol: item.symbol,
        nameHint: item.name,
      },
    };
  }

  if (item.marketType === 'perp') {
    const itemId = normalizeText(item.itemId);
    if (!itemId) return null;
    return {
      key: `search:perp:${itemId.toLowerCase()}`,
      input: {
        itemId,
        marketType: 'perp',
        symbol: item.symbol,
        venue: item.source,
        nameHint: item.name,
      },
    };
  }

  const itemId = normalizeText(item.itemId);
  if (!itemId) return null;
  return {
    key: `search:prediction:${itemId.toLowerCase()}`,
    input: {
      itemId,
      marketType: 'prediction',
      venue: item.source,
      marketId: itemId.replace(/^polymarket:/i, ''),
      outcomeId: 'default',
      nameHint: item.name,
    },
  };
}

async function buildMarketSearchIdentityMap(
  env: AppEnv['Bindings'],
  items: MarketSearchResultItem[],
): Promise<Map<string, ResolvedAsset>> {
  if (!items.length) return new Map<string, ResolvedAsset>();
  const requests: IdentityResolveRequest[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const request = buildMarketSearchResolveRequest(item);
    if (!request || seen.has(request.key)) continue;
    seen.add(request.key);
    requests.push(request);
  }
  if (!requests.length) return new Map<string, ResolvedAsset>();

  const results = await resolveAssetIdentityBatch(
    env,
    requests.map((request) => request.input),
  );
  const identityMap = new Map<string, ResolvedAsset>();
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const result = results[index];
    if (!request || !result || !result.ok) continue;
    identityMap.set(request.key, result.result);
  }
  return identityMap;
}

function applyMarketSearchIdentity(
  item: MarketSearchResultItem,
  identityMap: Map<string, ResolvedAsset>,
): MarketSearchResultItem {
  const request = buildMarketSearchResolveRequest(item);
  if (!request) return item;
  const resolved = identityMap.get(request.key);
  if (!resolved) return item;
  return {
    ...item,
    asset_id: resolved.asset_id,
    instrument_id: resolved.instrument_id,
  };
}

function applyMarketSearchAssetIcons(
  item: MarketSearchResultItem,
  assetIconMap: Map<string, string>,
): MarketSearchResultItem {
  const assetId = item.asset_id?.trim();
  if (!assetId) return item;
  const logo = assetIconMap.get(assetId);
  if (!logo) return item;
  return {
    ...item,
    image: logo,
  };
}

function applyMarketSearchLookupIcon(
  item: MarketSearchResultItem,
  lookup: Awaited<ReturnType<typeof loadTokenIconLookup>> | null,
): MarketSearchResultItem {
  if (!lookup || item.image) return item;
  const image = resolveTokenIconFromLookup(lookup, {
    chain: item.chain,
    contract: item.contract,
    symbol: item.symbol,
    name: item.name,
  });
  if (!image) return item;
  return {
    ...item,
    image,
  };
}

function buildNativeMajorSearchResults(query: string): MarketSearchResultItem[] {
  const terms = buildSearchTerms(query);
  if (!terms.length) return [];
  return NATIVE_MAJOR_SEARCH_ITEMS
    .map((item) => ({
      item: {
        id: `native-major:${item.chain}`,
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
        contract: 'native',
      },
      score: scoreSearchMatch(`${item.symbol} ${item.name}`, terms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

function mapStoredMarketSearchRecordToItem(
  row: Awaited<ReturnType<typeof searchStoredMarketRecords>>[number],
): MarketSearchResultItem | null {
  const marketType = row.market_type === 'spot'
    ? (row.asset_class === 'equity_exposure' ? 'stock' : 'spot')
    : row.market_type;
  const symbol = (
    marketType === 'stock'
      ? normalizeText(parseInstrumentMetadata({
        instrument_id: row.instrument_id,
        asset_id: row.asset_id,
        market_type: row.market_type,
        venue: row.venue,
        symbol: row.instrument_symbol,
        chain: row.chain,
        contract_key: row.contract_key,
        source: 'db',
        source_item_id: row.source_item_id,
        metadata_json: row.metadata_json,
        status: 'active',
        created_at: row.updated_at,
        updated_at: row.updated_at,
      }).underlying_ticker) ?? row.asset_symbol ?? row.instrument_symbol
      : row.instrument_symbol ?? row.asset_symbol
  )?.trim() ?? '';
  if (!symbol) return null;
  const name = (row.asset_name ?? row.asset_symbol ?? row.instrument_symbol ?? symbol).trim();
  const contract = row.market_type === 'spot' && row.contract_key
    ? contractKeyToUpstreamContract(row.contract_key)
    : null;
  return {
    id: row.instrument_id,
    marketType,
    symbol,
    name,
    image: row.logo_uri,
    currentPrice: null,
    change24h: null,
    volume24h: null,
    probability: null,
    source: row.venue ?? 'db',
    externalUrl: null,
    itemId: marketType === 'spot' ? null : (buildLegacyItemIdForInstrument({
      instrument_id: row.instrument_id,
      asset_id: row.asset_id,
      market_type: row.market_type,
      venue: row.venue,
      symbol: row.instrument_symbol,
      chain: row.chain,
      contract_key: row.contract_key,
      source: 'db',
      source_item_id: row.source_item_id,
      metadata_json: row.metadata_json,
      status: 'active',
      created_at: row.updated_at,
      updated_at: row.updated_at,
    }) ?? row.instrument_id),
    chain: row.market_type === 'spot' ? row.chain : null,
    contract: row.market_type === 'spot' ? contract : null,
    asset_id: row.asset_id,
    instrument_id: row.instrument_id,
  };
}

function normalizeContractQuery(chain: string, raw: unknown): string {
  const value = normalizeText(raw) ?? '';
  return chain === 'sol' ? value : value.toLowerCase();
}

function toUpperSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return value || null;
}

function isNativeLikeContract(raw: unknown): boolean {
  const value = normalizeText(raw)?.toLowerCase() ?? '';
  if (!value || value === 'native') return true;
  if (value === '0x0000000000000000000000000000000000000000') return true;
  return false;
}

function getExpectedNativeSymbol(chain: string): string {
  const normalized = (chain ?? '').trim().toLowerCase();
  if (normalized === 'bnb') return 'BNB';
  return 'ETH';
}

function mapTopAssetToTokenDetail(asset: MarketTopAsset): BitgetTokenDetail {
  return {
    asset_id: asset.asset_id,
    chain_asset_id: asset.chain_asset_id,
    chain: asset.chain,
    contract: asset.contract,
    symbol: asset.symbol,
    name: asset.name,
    image: asset.image ?? null,
    priceChange24h: asset.price_change_percentage_24h ?? null,
    currentPriceUsd: asset.current_price ?? null,
    holders: null,
    totalSupply: null,
    liquidityUsd: null,
    top10HolderPercent: null,
    devHolderPercent: null,
    lockLpPercent: null,
  };
}

async function buildNativeTokenDetailFallback(
  env: AppEnv['Bindings'],
  chain: string,
): Promise<BitgetTokenDetail | null> {
  const assets = await fetchTopMarketAssets(env, {
    source: 'coingecko',
    name: 'marketCap',
    limit: 120,
    chains: [chain],
  });
  const normalizedChain = chain.trim().toLowerCase();
  const expectedSymbol = getExpectedNativeSymbol(normalizedChain);
  const primary =
    assets.find((asset) => asset.chain === normalizedChain && isNativeLikeContract(asset.contract))
    ?? assets.find((asset) => (asset.symbol ?? '').trim().toUpperCase() === expectedSymbol && isNativeLikeContract(asset.contract))
    ?? null;
  if (!primary) return null;
  return mapTopAssetToTokenDetail(primary);
}

type BrowseMarketHint = 'spot' | 'perp' | 'stock';

type IdentityResolveRequest = {
  key: string;
  input: ResolveAssetInput;
};

type BitgetTokenDetailWithIdentity = BitgetTokenDetail & {
  instrument_id?: string;
};

type BitgetTokenSecurityAuditWithIdentity = BitgetTokenSecurityAudit & {
  instrument_id?: string;
};

function buildTopAssetResolveRequest(asset: MarketTopAsset): IdentityResolveRequest | null {
  const chain = normalizeText(asset.chain);
  if (!chain) return null;
  const contract = normalizeText(asset.contract) ?? 'native';
  const normalizedChain = normalizeMarketChain(chain);
  return {
    key: `top:${normalizedChain}:${toContractKey(contract)}`,
    input: {
      chain: normalizedChain,
      contract,
      marketType: 'spot',
      symbol: asset.symbol,
      nameHint: asset.name,
    },
  };
}

function applyTopAssetIdentity(asset: MarketTopAsset, identityMap: Map<string, ResolvedAsset>): MarketTopAsset {
  const request = buildTopAssetResolveRequest(asset);
  if (!request) return asset;
  const resolved = identityMap.get(request.key);
  if (!resolved) return asset;
  return {
    ...asset,
    asset_id: resolved.asset_id,
    instrument_id: resolved.instrument_id,
  };
}

async function buildTopAssetIdentityMap(
  env: AppEnv['Bindings'],
  assets: MarketTopAsset[],
): Promise<Map<string, ResolvedAsset>> {
  if (!assets.length) return new Map<string, ResolvedAsset>();
  const requests: IdentityResolveRequest[] = [];
  const seen = new Set<string>();
  for (const asset of assets) {
    const request = buildTopAssetResolveRequest(asset);
    if (!request || seen.has(request.key)) continue;
    seen.add(request.key);
    requests.push(request);
  }
  if (!requests.length) return new Map<string, ResolvedAsset>();

  const results = await resolveAssetIdentityBatch(
    env,
    requests.map((item) => item.input),
  );
  const identityMap = new Map<string, ResolvedAsset>();
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const result = results[index];
    if (!request || !result || !result.ok) continue;
    identityMap.set(request.key, result.result);
  }
  return identityMap;
}

function buildTokenDetailResolveRequest(detail: BitgetTokenDetail): IdentityResolveRequest | null {
  const chain = normalizeText(detail.chain);
  if (!chain) return null;
  const contract = normalizeText(detail.contract) ?? 'native';
  const normalizedChain = normalizeMarketChain(chain);
  return {
    key: `token:${normalizedChain}:${toContractKey(contract)}`,
    input: {
      chain: normalizedChain,
      contract,
      marketType: 'spot',
      symbol: detail.symbol,
      nameHint: detail.name,
    },
  };
}

function applyTokenDetailIdentity(
  detail: BitgetTokenDetail,
  identityMap: Map<string, ResolvedAsset>,
): BitgetTokenDetailWithIdentity {
  const request = buildTokenDetailResolveRequest(detail);
  if (!request) return detail;
  const resolved = identityMap.get(request.key);
  if (!resolved) return detail;
  return {
    ...detail,
    asset_id: resolved.asset_id,
    instrument_id: resolved.instrument_id,
  };
}

function buildTokenSecurityResolveRequest(audit: BitgetTokenSecurityAudit): IdentityResolveRequest | null {
  const chain = normalizeText(audit.chain);
  if (!chain) return null;
  const contract = normalizeText(audit.contract) ?? 'native';
  const normalizedChain = normalizeMarketChain(chain);
  return {
    key: `spot:${normalizedChain}:${toContractKey(contract)}`,
    input: {
      marketType: 'spot',
      chain: normalizedChain,
      contract,
    },
  };
}

function applyTokenSecurityIdentity(
  audit: BitgetTokenSecurityAudit,
  identityMap: Map<string, ResolvedAsset>,
): BitgetTokenSecurityAuditWithIdentity {
  const request = buildTokenSecurityResolveRequest(audit);
  if (!request) return audit;
  const resolved = identityMap.get(request.key);
  if (!resolved?.instrument_id) return audit;
  return {
    ...audit,
    instrument_id: resolved.instrument_id,
  };
}

async function buildTokenDetailIdentityMap(
  env: AppEnv['Bindings'],
  details: BitgetTokenDetail[],
): Promise<Map<string, ResolvedAsset>> {
  if (!details.length) return new Map<string, ResolvedAsset>();
  const requests: IdentityResolveRequest[] = [];
  const seen = new Set<string>();
  for (const detail of details) {
    const request = buildTokenDetailResolveRequest(detail);
    if (!request || seen.has(request.key)) continue;
    seen.add(request.key);
    requests.push(request);
  }
  if (!requests.length) return new Map<string, ResolvedAsset>();

  const results = await resolveAssetIdentityBatch(
    env,
    requests.map((item) => item.input),
  );
  const identityMap = new Map<string, ResolvedAsset>();
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const result = results[index];
    if (!request || !result || !result.ok) continue;
    identityMap.set(request.key, result.result);
  }
  return identityMap;
}

function buildBrowseMarketResolveRequest(
  item: TradeBrowseMarketItem,
  hint: BrowseMarketHint,
): IdentityResolveRequest | null {
  if (hint === 'spot') {
    const chain = normalizeText(item.chain);
    const contract = normalizeText(item.contract);
    if (!chain || !contract) return null;
    return {
      key: `spot:${normalizeMarketChain(chain)}:${contract.toLowerCase()}`,
      input: {
        chain,
        contract,
        marketType: 'spot',
        symbol: item.symbol,
        nameHint: item.name,
      },
    };
  }

  if (hint === 'stock') {
    const itemId = normalizeText(item.id);
    if (!itemId) return null;
    return {
      key: `stock:${itemId.toLowerCase()}`,
      input: {
        itemId,
        marketType: 'spot',
        assetClassHint: 'equity_exposure',
        symbol: item.symbol,
        nameHint: item.name,
      },
    };
  }

  const itemId = normalizeText(item.id);
  if (!itemId) return null;
  return {
    key: `perp:${itemId.toLowerCase()}`,
    input: {
      itemId,
      marketType: 'perp',
      symbol: item.symbol,
      venue: item.source,
      nameHint: item.name,
    },
  };
}

function buildBrowsePredictionResolveRequest(item: TradeBrowsePredictionItem): IdentityResolveRequest | null {
  const itemId = normalizeText(item.id);
  if (!itemId) return null;
  return {
    key: `pred:${itemId.toLowerCase()}`,
    input: {
      itemId,
      marketType: 'prediction',
      venue: item.source,
      marketId: item.id.replace(/^polymarket:/i, ''),
      outcomeId: 'default',
      nameHint: item.title,
    },
  };
}

function applyBrowseMarketIdentity(
  item: TradeBrowseMarketItem,
  hint: BrowseMarketHint,
  identityMap: Map<string, ResolvedAsset>,
): TradeBrowseMarketItem {
  const request = buildBrowseMarketResolveRequest(item, hint);
  if (!request) return item;
  const resolved = identityMap.get(request.key);
  if (!resolved) return item;
  return {
    ...item,
    asset_id: resolved.asset_id,
    instrument_id: resolved.instrument_id,
  };
}

function applyBrowsePredictionIdentity(
  item: TradeBrowsePredictionItem,
  identityMap: Map<string, ResolvedAsset>,
): TradeBrowsePredictionItem {
  const request = buildBrowsePredictionResolveRequest(item);
  if (!request) return item;
  const resolved = identityMap.get(request.key);
  if (!resolved) return item;
  return {
    ...item,
    asset_id: resolved.asset_id,
    instrument_id: resolved.instrument_id,
  };
}

async function buildTradeBrowseIdentityMap(
  env: AppEnv['Bindings'],
  payload: {
    topMovers: TradeBrowseMarketItem[];
    trendings: TradeBrowseMarketItem[];
    stocks: TradeBrowseMarketItem[];
    perps: TradeBrowseMarketItem[];
    predictions: TradeBrowsePredictionItem[];
  },
): Promise<Map<string, ResolvedAsset>> {
  const requests: IdentityResolveRequest[] = [];
  const seen = new Set<string>();
  const append = (request: IdentityResolveRequest | null): void => {
    if (!request) return;
    if (seen.has(request.key)) return;
    seen.add(request.key);
    requests.push(request);
  };

  for (const item of payload.topMovers) append(buildBrowseMarketResolveRequest(item, 'spot'));
  for (const item of payload.trendings) append(buildBrowseMarketResolveRequest(item, 'spot'));
  for (const item of payload.stocks) append(buildBrowseMarketResolveRequest(item, 'stock'));
  for (const item of payload.perps) append(buildBrowseMarketResolveRequest(item, 'perp'));
  for (const item of payload.predictions) append(buildBrowsePredictionResolveRequest(item));

  if (!requests.length) return new Map<string, ResolvedAsset>();

  const results = await resolveAssetIdentityBatch(
    env,
    requests.map((request) => request.input),
  );

  const identityMap = new Map<string, ResolvedAsset>();
  for (let index = 0; index < requests.length; index += 1) {
    const result = results[index];
    const request = requests[index];
    if (!request || !result || !result.ok) continue;
    identityMap.set(request.key, result.result);
  }
  return identityMap;
}

async function enrichBrowseMarketItemIdentity(
  env: AppEnv['Bindings'],
  item: TradeBrowseMarketItem,
  hint: BrowseMarketHint,
): Promise<TradeBrowseMarketItem> {
  const request = buildBrowseMarketResolveRequest(item, hint);
  if (!request) return item;
  try {
    const resolved = await resolveAssetIdentity(env, request.input);
    return {
      ...item,
      asset_id: resolved.asset_id,
      instrument_id: resolved.instrument_id,
    };
  } catch {
    return item;
  }
}

async function enrichBrowsePredictionItemIdentity(
  env: AppEnv['Bindings'],
  item: TradeBrowsePredictionItem,
): Promise<TradeBrowsePredictionItem> {
  const request = buildBrowsePredictionResolveRequest(item);
  if (!request) return item;
  try {
    const resolved = await resolveAssetIdentity(env, request.input);
    return {
      ...item,
      asset_id: resolved.asset_id,
      instrument_id: resolved.instrument_id,
    };
  } catch {
    return item;
  }
}

export function registerMarketRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/market/top-assets', async (c) => {
    const limitRaw = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
    const name = normalizeTopAssetListName(c.req.query('name'));
    const source = normalizeTopAssetSource(c.req.query('source'));
    const category = (c.req.query('category') ?? '').trim() || undefined;
    const chainsRaw = c.req.query('chains') ?? '';
    const chains = chainsRaw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    try {
      const assets = await fetchTopMarketAssets(c.env, {
        source,
        name,
        limit,
        chains,
        category,
      });
      const identityMap = await buildTopAssetIdentityMap(c.env, assets);
      const normalizedAssets = assets.map((asset) => applyTopAssetIdentity(asset, identityMap));
      return c.json({ assets: normalizedAssets });
    } catch (error) {
      return c.json(
        {
          error: 'market_top_assets_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/trade-browse', async (c) => {
    try {
      const payload = await fetchTradeBrowse(c.env);
      const identityMap = await buildTradeBrowseIdentityMap(c.env, payload);
      const topMovers = payload.topMovers.map((item) => applyBrowseMarketIdentity(item, 'spot', identityMap));
      const trendings = payload.trendings.map((item) => applyBrowseMarketIdentity(item, 'spot', identityMap));
      const stocks = payload.stocks.map((item) => applyBrowseMarketIdentity(item, 'stock', identityMap));
      const perps = payload.perps.map((item) => applyBrowseMarketIdentity(item, 'perp', identityMap));
      const predictions = payload.predictions.map((item) => applyBrowsePredictionIdentity(item, identityMap));

      return c.json({
        ...payload,
        topMovers,
        trendings,
        stocks,
        perps,
        predictions,
      });
    } catch (error) {
      return c.json(
        {
          error: 'trade_browse_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/trade-kline', async (c) => {
    const type = normalizeTradeMarketDetailType(c.req.query('type'));
    const id = (c.req.query('id') ?? '').trim();
    const period = (c.req.query('period') ?? '1h').trim();
    const optionTokenId = (c.req.query('optionTokenId') ?? '').trim() || null;
    const sizeRaw = Number(c.req.query('size'));
    const size = Number.isFinite(sizeRaw) ? sizeRaw : 60;

    if (!type || !id) {
      console.warn('[trade-kline-debug][invalid_query]', {
        type,
        id,
        period,
        size,
        optionTokenId,
      });
      return c.json({ error: 'invalid_trade_kline_query' }, 400);
    }

    console.info('[trade-kline-debug][request]', {
      type,
      id,
      period,
      size,
      optionTokenId,
    });

    try {
      const candles = await fetchTradeMarketKline(c.env, {
        type,
        id,
        period,
        size,
        optionTokenId,
      });
      console.info('[trade-kline-debug][response]', {
        type,
        id,
        period,
        size,
        optionTokenId,
        candles: candles.length,
        firstTs: candles[0]?.time ?? null,
        lastTs: candles[candles.length - 1]?.time ?? null,
      });
      return c.json({ type, id, period, candles });
    } catch (error) {
      console.error('[trade-kline-debug][error]', {
        type,
        id,
        period,
        size,
        optionTokenId,
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          error: 'trade_market_kline_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/trade-detail', async (c) => {
    const type = normalizeTradeMarketDetailType(c.req.query('type'));
    const id = (c.req.query('id') ?? '').trim();
    if (!type || !id) {
      console.warn('[trade-detail-debug][invalid_query]', {
        type,
        id,
      });
      return c.json({ error: 'invalid_trade_detail_query' }, 400);
    }

    console.info('[trade-detail-debug][request]', {
      type,
      id,
    });

    try {
      const detail = await fetchTradeMarketDetail(c.env, { type, id });
      if (!detail) {
        console.warn('[trade-detail-debug][not_found]', {
          type,
          id,
        });
        return c.json({ error: 'trade_detail_not_found' }, 404);
      }
      console.info('[trade-detail-debug][response]', {
        type,
        id,
        source: 'source' in detail ? detail.source : null,
      });
      if (type === 'stock' && 'symbol' in detail) {
        const enriched = await enrichBrowseMarketItemIdentity(c.env, detail, 'stock');
        return c.json({ type, id, detail: enriched });
      }
      if (type === 'perp' && 'symbol' in detail) {
        const enriched = await enrichBrowseMarketItemIdentity(c.env, detail, 'perp');
        return c.json({ type, id, detail: enriched });
      }
      if (type === 'prediction' && detail.source === 'polymarket') {
        const enriched = await enrichBrowsePredictionItemIdentity(c.env, detail);
        return c.json({ type, id, detail: enriched });
      }
      return c.json({ type, id, detail });
    } catch (error) {
      console.error('[trade-detail-debug][error]', {
        type,
        id,
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          error: 'trade_market_detail_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/prediction-detail', async (c) => {
    const id = (c.req.query('id') ?? '').trim();
    if (!id) {
      return c.json({ error: 'invalid_prediction_detail_query' }, 400);
    }

    try {
      const detail = await fetchPredictionEventDetail(c.env, id);
      if (!detail) {
        return c.json({ error: 'prediction_detail_not_found' }, 404);
      }
      return c.json({ id, detail });
    } catch (error) {
      return c.json(
        {
          error: 'prediction_detail_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/prediction-kline', async (c) => {
    const id = (c.req.query('id') ?? '').trim();
    const period = (c.req.query('period') ?? 'all').trim();
    const sizeRaw = Number(c.req.query('size'));
    const size = Number.isFinite(sizeRaw) ? sizeRaw : 240;
    if (!id) {
      return c.json({ error: 'invalid_prediction_kline_query' }, 400);
    }

    try {
      const series = await fetchPredictionEventSeries(c.env, id, period, size);
      return c.json({ id, period, series });
    } catch (error) {
      return c.json(
        {
          error: 'prediction_kline_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/watchlist', async (c) => {
    const userId = c.get('userId');
    const limitRaw = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const assets = await listUserWatchlistAssets(c.env, userId, limit ?? 50);
    return c.json({ assets });
  });

  app.post('/v1/market/watchlist', async (c) => {
    const userId = c.get('userId');
    const body = await c.req
      .json<{
        watchType?: string;
        itemId?: string;
        chain?: string;
        contract?: string;
        symbol?: string;
        name?: string;
        image?: string;
        source?: string;
        change24h?: number;
        externalUrl?: string;
      }>()
      .catch(() => null);

    if (!body) {
      return c.json({ error: 'invalid_watchlist_payload' }, 400);
    }

    try {
      const asset = await upsertUserWatchlistAsset(c.env, userId, {
        watchType: body.watchType ?? null,
        itemId: body.itemId ?? null,
        chain: body.chain ?? null,
        contract: body.contract ?? null,
        symbol: body.symbol ?? null,
        name: body.name ?? null,
        image: body.image ?? null,
        source: body.source ?? null,
        change24h: body.change24h ?? null,
        externalUrl: body.externalUrl ?? null,
      });
      return c.json({ ok: true, asset });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      if (
        message === 'invalid_watchlist_type'
        || message === 'invalid_watchlist_item'
        || message === 'invalid_watchlist_chain'
        || message === 'invalid_watchlist_contract'
      ) {
        return c.json({ error: message }, 400);
      }
      return c.json(
        {
          error: 'watchlist_upsert_failed',
          message,
        },
        500,
      );
    }
  });

  app.post('/v1/market/watchlist/remove', async (c) => {
    const userId = c.get('userId');
    const body = await c.req
      .json<{
        id?: string;
        chain?: string;
        contract?: string;
      }>()
      .catch(() => null);

    if (!body) {
      return c.json({ error: 'invalid_watchlist_payload' }, 400);
    }

    try {
      const removed = await removeUserWatchlistAsset(c.env, userId, {
        id: body.id ?? null,
        chain: body.chain ?? null,
        contract: body.contract ?? null,
      });
      return c.json({ ok: true, removed });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      if (message === 'invalid_watchlist_remove_target') {
        return c.json({ error: message }, 400);
      }
      return c.json(
        {
          error: 'watchlist_remove_failed',
          message,
        },
        500,
      );
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
    const chain = (c.req.query('chain') ?? '').trim().toLowerCase();
    const contract = normalizeContractQuery(chain, c.req.query('contract'));
    if (!chain) {
      return c.json({ error: 'invalid_chain' }, 400);
    }

    if (chain === 'sol') {
      const details = await fetchSolanaTokenDetails(c.env, [contract || 'native']);
      const detail = details.get(contract || 'native') ?? details.get('native') ?? null;
      if (!detail) {
        return c.json({ error: 'token_not_found' }, 404);
      }
      return c.json({ detail });
    }

    if (isNativeLikeContract(contract)) {
      try {
        const fallback = await buildNativeTokenDetailFallback(c.env, chain);
        if (fallback) {
          const iconLookup = await loadTokenIconLookup(c.env, {
            source: 'auto',
            name: 'marketCap',
            limit: 200,
            chains: [fallback.chain],
            categories: TOKENIZED_STOCK_ICON_CATEGORIES,
          });
          const image = fallback.image ?? resolveTokenIconFromLookup(iconLookup, {
            chain: fallback.chain,
            contract: fallback.contract,
            symbol: fallback.symbol,
            name: fallback.name,
          });
          const normalizedDetail: BitgetTokenDetail = {
            ...fallback,
            image,
          };
          const identityMap = await buildTokenDetailIdentityMap(c.env, [normalizedDetail]);
          return c.json({
            detail: applyTokenDetailIdentity(normalizedDetail, identityMap),
          });
        }
      } catch {
        // Fall through to Bitget lookup if native fallback fails.
      }
    }

    try {
      const detail = await fetchBitgetTokenDetail(c.env, chain, contract);
      if (!detail) {
        return c.json({ error: 'token_not_found' }, 404);
      }
      let normalizedDetail = detail;
      if (!normalizeText(normalizedDetail.image)) {
        const iconLookup = await loadTokenIconLookup(c.env, {
          source: 'auto',
          name: 'marketCap',
          limit: 200,
          chains: [normalizedDetail.chain],
          categories: TOKENIZED_STOCK_ICON_CATEGORIES,
        });
        const image = resolveTokenIconFromLookup(iconLookup, {
          chain: normalizedDetail.chain,
          contract: normalizedDetail.contract,
          symbol: normalizedDetail.symbol,
          name: normalizedDetail.name,
        });
        normalizedDetail = {
          ...normalizedDetail,
          image: image ?? normalizedDetail.image,
        };
      }

      const identityMap = await buildTokenDetailIdentityMap(c.env, [normalizedDetail]);
      return c.json({
        detail: applyTokenDetailIdentity(normalizedDetail, identityMap),
      });
    } catch (error) {
      return c.json(
        {
          error: 'bitget_token_detail_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/token-security', async (c) => {
    const chain = (c.req.query('chain') ?? '').trim().toLowerCase();
    const contract = normalizeContractQuery(chain, c.req.query('contract'));
    if (!chain) {
      return c.json({ error: 'invalid_chain' }, 400);
    }
    if (chain === 'sol') {
      return c.json({ audit: null });
    }
    if (isNativeLikeContract(contract)) {
      return c.json({ audit: null });
    }

    try {
      const audit = await fetchBitgetTokenSecurityAudit(c.env, chain, contract);
      if (!audit) {
        return c.json({ audit: null });
      }
      const request = buildTokenSecurityResolveRequest(audit);
      const identityResults = request
        ? await resolveAssetIdentityBatch(c.env, [request.input])
        : [];
      const identityMap = new Map<string, ResolvedAsset>();
      if (request && identityResults[0]?.ok) {
        identityMap.set(request.key, identityResults[0].result);
      }
      return c.json({
        audit: applyTokenSecurityIdentity(audit, identityMap),
      });
    } catch (error) {
      return c.json(
        {
          error: 'bitget_token_security_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.post('/v1/market/token-details', async (c) => {
    const body = await c.req.json<{ tokens?: Array<{ chain?: string; contract?: string }> }>().catch(() => null);
    const tokens = (body?.tokens ?? [])
      .map((item) => ({
        chain: (item?.chain ?? '').trim().toLowerCase(),
        contract: normalizeContractQuery((item?.chain ?? '').trim().toLowerCase(), item?.contract),
      }))
      .filter((item) => Boolean(item.chain))
      .slice(0, 100);

    if (!tokens.length) {
      return c.json({ error: 'invalid_tokens' }, 400);
    }

    try {
      const solanaTokens = tokens.filter((item) => item.chain === 'sol');
      const nonSolanaTokens = tokens.filter((item) => item.chain !== 'sol');
      const [bitgetDetails, solanaDetailsMap] = await Promise.all([
        nonSolanaTokens.length ? fetchBitgetTokenDetails(c.env, nonSolanaTokens) : Promise.resolve([]),
        solanaTokens.length ? fetchSolanaTokenDetails(c.env, solanaTokens.map((item) => item.contract || 'native')) : Promise.resolve(new Map()),
      ]);
      const details = [
        ...bitgetDetails,
        ...solanaTokens.map((item) => ({
          key: `${item.chain}:${item.contract || 'native'}`,
          chain: item.chain,
          contract: item.contract,
          detail: solanaDetailsMap.get(item.contract || 'native') ?? null,
        })),
      ];
      const missingImageChains = [
        ...new Set(
          details
            .map((item) => item.detail)
            .filter((detail): detail is BitgetTokenDetail => detail != null && !normalizeText((detail as { image?: string | null }).image))
            .map((detail) => detail.chain.trim().toLowerCase())
            .filter(Boolean),
        ),
      ];
      let detailsWithImage = details;
      if (missingImageChains.length) {
        const iconLookup = await loadTokenIconLookup(c.env, {
          source: 'auto',
          name: 'marketCap',
          limit: 200,
          chains: missingImageChains,
          categories: TOKENIZED_STOCK_ICON_CATEGORIES,
        });
        detailsWithImage = details.map((item) => {
          const detail = item.detail;
          if (!detail || normalizeText(detail.image)) return item;
          const image = resolveTokenIconFromLookup(iconLookup, {
            chain: detail.chain,
            contract: detail.contract,
            symbol: detail.symbol,
            name: detail.name,
          });
          if (!image) return item;
          return {
            ...item,
            detail: {
              ...detail,
              image,
            },
          };
        });
      }

      const identityMap = await buildTokenDetailIdentityMap(
        c.env,
        detailsWithImage
          .map((item) => item.detail)
          .filter((detail): detail is BitgetTokenDetail => detail != null),
      );
      const enriched = detailsWithImage.map((item) => {
        if (!item.detail) return item;
        return {
          ...item,
          detail: applyTokenDetailIdentity(item.detail, identityMap),
        };
      });
      return c.json({ details: enriched });
    } catch (error) {
      return c.json(
        {
          error: 'bitget_token_details_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/kline', async (c) => {
    const chain = (c.req.query('chain') ?? '').trim().toLowerCase();
    const contract = normalizeContractQuery(chain, c.req.query('contract'));
    const period = (c.req.query('period') ?? '1h').trim();
    const sizeRaw = Number(c.req.query('size'));
    const size = Number.isFinite(sizeRaw) ? sizeRaw : 60;
    if (!chain) {
      return c.json({ error: 'invalid_chain' }, 400);
    }

    try {
      const resolveBinanceFallbackCandles = async (): Promise<null | Awaited<ReturnType<typeof fetchBinanceSpotKlines>>> => {
        if (chain === 'sol') return null;
        let symbol: string | null = null;
        try {
          const detail = await fetchBitgetTokenDetail(c.env, chain, contract);
          symbol = toUpperSymbol(detail?.symbol);
        } catch {
          symbol = null;
        }
        if (!symbol) return null;
        const fallback = await fetchBinanceSpotKlines(symbol, period, size);
        return fallback.length > 0 ? fallback : null;
      };

      const candles = await fetchBitgetTokenKline(c.env, {
        chain,
        contract,
        period,
        size,
      });
      const fallback = (!candles.length || isKlineStale(candles, period))
        ? await resolveBinanceFallbackCandles()
        : null;
      if (fallback && shouldPreferFallbackCandles(candles, fallback, period)) {
        return c.json({ period, candles: fallback, source: 'binance_spot_fallback' });
      }
      return c.json({ period, candles });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      try {
        const detail = await fetchBitgetTokenDetail(c.env, chain, contract);
        const symbol = toUpperSymbol(detail?.symbol);
        if (symbol) {
          const fallback = await fetchBinanceSpotKlines(symbol, period, size);
          if (fallback.length > 0) {
            return c.json({ period, candles: fallback, source: 'binance_spot_fallback' });
          }
        }
      } catch {
        // ignore
      }
      if (message.includes('bgw_http_429')) {
        return c.json(
          {
            error: 'market_kline_rate_limited',
            message,
          },
          429,
        );
      }
      return c.json(
        {
          error: 'bitget_kline_failed',
          message,
        },
        502,
      );
    }
  });

  app.get('/v1/market/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const limitRaw = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitRaw) ? Math.min(limitRaw, 50) : 20;
    if (!q) {
      return c.json({ results: [] });
    }

    try {
      const candidateLimit = Math.min(Math.max(limit * 4, 24), 80);
      const searchTerms = buildSearchTerms(q);

      const nativeMajorResults = buildNativeMajorSearchResults(q);
      const [spotResult, storedResult] = await Promise.allSettled([
        searchBinanceSpotTokens(q, candidateLimit),
        searchStoredMarketRecords(c.env.DB, q, candidateLimit),
      ]);
      const candidates: Array<{
        item: MarketSearchResultItem;
        score: number;
      }> = [];

      for (const item of nativeMajorResults) {
        candidates.push({
          item,
          score: scoreSearchMatch(`${item.symbol} ${item.name}`, searchTerms) + 20,
        });
      }

      if (spotResult.status === 'fulfilled') {
        for (const item of spotResult.value) {
          if (item.volume24h != null && item.volume24h < 1000) continue;
          const symbol = item.stockState ? item.stockTicker : item.symbol;
          const exactSymbolMatch = symbol.trim().toUpperCase() === q.trim().toUpperCase();
          const score = scoreSearchMatch(`${item.stockTicker} ${item.symbol} ${item.name}`, searchTerms)
            + (exactSymbolMatch ? 25 : 0)
            + (item.nativeAddressFlag && exactSymbolMatch ? 50 : 0);
          if (score <= 0) continue;
          candidates.push({
            score,
            item: {
              id: item.id,
              marketType: item.stockState ? 'stock' : 'spot',
              symbol,
              name: item.name,
              image: item.image,
              currentPrice: item.currentPrice,
              change24h: item.change24h,
              volume24h: item.volume24h,
              probability: null,
              source: 'binance',
              externalUrl: null,
              itemId: item.stockState ? item.id : null,
              chain: item.stockState ? null : normalizeMarketChain(item.chain),
              contract: item.stockState ? null : item.contract,
            },
          });
        }
      }

      if (storedResult.status === 'fulfilled') {
        for (const row of storedResult.value) {
          const item = mapStoredMarketSearchRecordToItem(row);
          if (!item) continue;
          const score = scoreSearchMatch(
            `${item.symbol} ${item.name} ${row.venue ?? ''} ${row.source_item_id ?? ''}`,
            searchTerms,
          );
          if (score <= 0) continue;
          candidates.push({ item, score });
        }
      }

      if (!candidates.length) {
        if (spotResult.status === 'rejected' && storedResult.status === 'rejected') {
          throw new Error('market_search_sources_unavailable');
        }
        return c.json({ results: [] });
      }

      const identityMap = await buildMarketSearchIdentityMap(
        c.env,
        candidates.map((entry) => entry.item),
      );
      const resolvedItems = candidates.map((entry) => ({
        ...entry,
        item: applyMarketSearchIdentity(entry.item, identityMap),
      }));
      const assetIds = resolvedItems
        .map((entry) => entry.item.asset_id?.trim())
        .filter((value): value is string => Boolean(value));
      const assetRows = await listAssetsByIds(c.env.DB, assetIds);
      const assetIconMap = new Map<string, string>();
      for (const row of assetRows) {
        const logo = row.logo_uri?.trim();
        if (!logo) continue;
        assetIconMap.set(row.asset_id, logo);
      }
      const [generalIconLookup, stockIconLookup] = await Promise.all([
        loadTokenIconLookup(c.env, {
          source: 'auto',
          name: 'marketCap',
          limit: 200,
          chains: ['eth', 'base', 'bnb', 'sol'],
        }).catch(() => null),
        loadTokenIconLookup(c.env, {
          source: 'auto',
          name: 'marketCap',
          limit: 200,
          chains: ['eth', 'base', 'bnb', 'sol'],
          categories: TOKENIZED_STOCK_ICON_CATEGORIES,
        }).catch(() => null),
      ]);

      const dedupe = new Set<string>();
      const exactSpotSymbolSeen = new Set<string>();
      const exactSymbolQuery = q.trim().toUpperCase();
      const results = candidates
        .map((entry, index) => ({
          ...entry,
          item: (function withIcons() {
            const baseItem = applyMarketSearchAssetIcons(resolvedItems[index]?.item ?? entry.item, assetIconMap);
            const lookup = baseItem.marketType === 'stock' ? stockIconLookup : generalIconLookup;
            return applyMarketSearchLookupIcon(baseItem, lookup);
          })(),
        }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return Number(b.item.volume24h ?? 0) - Number(a.item.volume24h ?? 0);
        })
        .filter((entry) => {
          if (
            entry.item.marketType === 'spot'
            && entry.item.symbol.trim().toUpperCase() === exactSymbolQuery
          ) {
            if (exactSpotSymbolSeen.has(exactSymbolQuery)) return false;
            exactSpotSymbolSeen.add(exactSymbolQuery);
          }
          const dedupeKey =
            entry.item.instrument_id?.trim()
            || (entry.item.marketType === 'spot'
              ? `${entry.item.marketType}:${entry.item.chain ?? ''}:${entry.item.contract ?? ''}`
              : `${entry.item.marketType}:${entry.item.itemId ?? entry.item.id}`);
          if (dedupe.has(dedupeKey)) return false;
          dedupe.add(dedupeKey);
          return true;
        })
        .slice(0, limit)
        .map((entry) => ({
          ...entry.item,
          itemId: entry.item.marketType === 'spot'
            ? null
            : entry.item.instrument_id?.trim() || entry.item.itemId,
        }));
      return c.json({ results });
    } catch (error) {
      return c.json(
        {
          error: 'market_search_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/sources', (c) => {
    return c.json({
      realtime: {
        mode: 'mixed_proxy',
        providers: [
          {
            name: 'coingecko',
            rest: 'https://api.coingecko.com/api/v3/coins/markets',
            use_for: ['topGainers', 'topLosers', 'topVolume', 'marketCap', 'trending'],
          },
          {
            name: 'bitget_wallet_tob',
            rest: 'https://bopenapi.bgwapi.io/bgw-pro/market/v3/topRank/detail',
            use_for: ['fallback_top_assets'],
          },
        ],
      },
      klines: {
        mode: 'signed_rest_polling',
        providers: [
          {
            name: 'bitget_wallet_tob',
            rest: 'https://bopenapi.bgwapi.io/bgw-pro/market/v3/coin/getKline',
          },
        ],
      },
      tokenDetail: {
        mode: 'signed_rest',
        providers: [
          {
            name: 'bitget_wallet_tob',
            rest: 'https://bopenapi.bgwapi.io/bgw-pro/market/v3/coin/batchGetBaseInfo',
          },
        ],
      },
      strategy: {
        topAssets: 'coingecko_first_with_bitget_fallback',
        tradeBrowse: {
          topMovers: 'bitget_primary',
          trendings: 'coingecko_top_volume_without_stablecoins',
          stocks: 'binance_spot_top_volume',
          perps: 'hyperliquid_info_api',
          prediction: 'polymarket_gamma_api',
        },
        tokenDetail: 'native_coingecko_fastpath_else_bitget_wallet_tob',
        klines: 'bitget_wallet_tob',
      },
      note: 'Top asset rankings are resolved by CoinGecko first, then fallback to Bitget. Stocks use Binance spot pricing, with icons mapped from CoinGecko tokenized-stock data. Token detail uses a native-asset CoinGecko fast path, otherwise Bitget. Kline remains on Bitget.',
      iconPriority: 'stocks_coingecko_tokenized_stock;others_source_icon',
    });
  });
}
