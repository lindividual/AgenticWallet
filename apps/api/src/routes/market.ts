import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import type { BitgetTokenDetail, MarketTopAsset } from '../services/bitgetWallet';
import { fetchBitgetTokenDetail, fetchBitgetTokenDetails, fetchBitgetTokenKline } from '../services/bitgetWallet';
import { getCoinGeckoCoinListSyncStatus, syncCoinGeckoCoinListPlatforms } from '../services/coingecko';
import {
  fetchTopMarketAssets,
  loadTokenIconLookup,
  normalizeTopAssetListName,
  normalizeTopAssetSource,
  resolveTokenIconFromLookup,
} from '../services/marketTopAssets';
import { normalizeMarketChain } from '../services/assetIdentity';
import {
  fetchTradeBrowse,
  fetchTradeMarketDetail,
  fetchTradeMarketKline,
  normalizeTradeMarketDetailType,
} from '../services/tradeBrowse';
import { searchBinanceTokens } from '../services/binance';
import { listUserWatchlistAssets, removeUserWatchlistAsset, upsertUserWatchlistAsset } from '../services/agent';

const TOKENIZED_STOCK_ICON_CATEGORIES = ['tokenized-stock', 'tokenized-stocks'];

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
      return c.json({ assets });
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
      return c.json(payload);
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
    const contract = (c.req.query('contract') ?? '').trim().toLowerCase();
    if (!chain) {
      return c.json({ error: 'invalid_chain' }, 400);
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
          return c.json({
            detail: {
              ...fallback,
              image,
            },
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
      if (normalizeText(detail.image)) {
        return c.json({ detail });
      }
      const iconLookup = await loadTokenIconLookup(c.env, {
        source: 'auto',
        name: 'marketCap',
        limit: 200,
        chains: [detail.chain],
        categories: TOKENIZED_STOCK_ICON_CATEGORIES,
      });
      const image = resolveTokenIconFromLookup(iconLookup, {
        chain: detail.chain,
        contract: detail.contract,
        symbol: detail.symbol,
        name: detail.name,
      });
      return c.json({
        detail: {
          ...detail,
          image: image ?? detail.image,
        },
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

  app.post('/v1/market/token-details', async (c) => {
    const body = await c.req.json<{ tokens?: Array<{ chain?: string; contract?: string }> }>().catch(() => null);
    const tokens = (body?.tokens ?? [])
      .map((item) => ({
        chain: (item?.chain ?? '').trim().toLowerCase(),
        contract: (item?.contract ?? '').trim().toLowerCase(),
      }))
      .filter((item) => Boolean(item.chain))
      .slice(0, 100);

    if (!tokens.length) {
      return c.json({ error: 'invalid_tokens' }, 400);
    }

    try {
      const details = await fetchBitgetTokenDetails(c.env, tokens);
      const missingImageChains = [
        ...new Set(
          details
            .map((item) => item.detail)
            .filter((detail): detail is BitgetTokenDetail => detail != null && !normalizeText(detail.image))
            .map((detail) => detail.chain.trim().toLowerCase())
            .filter(Boolean),
        ),
      ];
      if (!missingImageChains.length) {
        return c.json({ details });
      }

      const iconLookup = await loadTokenIconLookup(c.env, {
        source: 'auto',
        name: 'marketCap',
        limit: 200,
        chains: missingImageChains,
        categories: TOKENIZED_STOCK_ICON_CATEGORIES,
      });
      const enriched = details.map((item) => {
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
    const contract = (c.req.query('contract') ?? '').trim().toLowerCase();
    const period = (c.req.query('period') ?? '1h').trim();
    const sizeRaw = Number(c.req.query('size'));
    const size = Number.isFinite(sizeRaw) ? sizeRaw : 60;
    if (!chain) {
      return c.json({ error: 'invalid_chain' }, 400);
    }

    try {
      const candles = await fetchBitgetTokenKline(c.env, {
        chain,
        contract,
        period,
        size,
      });
      return c.json({ period, candles });
    } catch (error) {
      return c.json(
        {
          error: 'bitget_kline_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
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
      const items = await searchBinanceTokens(q, limit);
      const stockIconLookup = await loadTokenIconLookup(c.env, {
        source: 'auto',
        name: 'marketCap',
        limit: 200,
        categories: TOKENIZED_STOCK_ICON_CATEGORIES,
      });

      const results = items.map((item) => ({
        ...(function resolveIcon() {
          const contract = normalizeContractAddress(item.contract);
          const image = resolveTokenIconFromLookup(
            stockIconLookup,
            {
              symbol: item.stockTicker,
              name: item.name,
              chain: normalizeMarketChain(item.chain),
              contract,
            },
          );
          return { image };
        })(),
        id: item.id,
        symbol: item.stockTicker,
        name: item.name,
        currentPrice: item.currentPrice,
        change24h: item.change24h,
        volume24h: item.volume24h,
        source: 'binance',
        externalUrl: `https://www.binance.com/en/alpha/${item.alphaId}`,
      }));
      return c.json({ results });
    } catch (error) {
      return c.json(
        {
          error: 'binance_search_failed',
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
