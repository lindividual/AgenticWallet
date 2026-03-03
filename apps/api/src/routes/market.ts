import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getChainIdByMarketChain } from '../config/appConfig';
import { ingestTokenLists, listTokenCatalog, resolveBestTokenCatalogLogo } from '../services/market';
import { fetchBitgetTokenDetail, fetchBitgetTokenDetails, fetchBitgetTokenKline } from '../services/bitgetWallet';
import { getCoinGeckoCoinListSyncStatus, syncCoinGeckoCoinListPlatforms } from '../services/coingecko';
import {
  fetchTopMarketAssets,
  normalizeTopAssetListName,
  normalizeTopAssetSource,
} from '../services/marketTopAssets';
import { fetchMarketShelves } from '../services/marketShelves';
import {
  fetchTradeBrowse,
  fetchTradeMarketKline,
  normalizeTradeMarketDetailType,
} from '../services/tradeBrowse';
import { listUserWatchlistAssets, removeUserWatchlistAsset, upsertUserWatchlistAsset } from '../services/agent';

export function registerMarketRoutes(app: Hono<AppEnv>): void {
  app.post('/v1/market/tokens/ingest/run', async (c) => {
    const result = await ingestTokenLists(c.env);
    return c.json({ ok: true, ...result });
  });

  app.get('/v1/market/tokens', async (c) => {
    const chainIdRaw = c.req.query('chainId');
    const chainId = chainIdRaw ? Number(chainIdRaw) : undefined;
    const q = c.req.query('q') ?? undefined;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Number(limitRaw) : 50;
    const tokens = await listTokenCatalog(c.env.DB, {
      chainId: Number.isFinite(chainId) ? chainId : undefined,
      q,
      limit,
    });
    return c.json({ tokens });
  });

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

  app.get('/v1/market/shelves', async (c) => {
    const idsRaw = c.req.query('ids') ?? '';
    const shelfIds = idsRaw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const limitRaw = Number(c.req.query('limitPerShelf'));
    const limitPerShelf = Number.isFinite(limitRaw) ? limitRaw : undefined;

    try {
      const shelves = await fetchMarketShelves(c.env, {
        shelfIds,
        limitPerShelf,
      });
      return c.json({
        generatedAt: new Date().toISOString(),
        shelves,
      });
    } catch (error) {
      return c.json(
        {
          error: 'market_shelves_failed',
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
      return c.json({ error: 'invalid_trade_kline_query' }, 400);
    }

    try {
      const candles = await fetchTradeMarketKline(c.env, {
        type,
        id,
        period,
        size,
        optionTokenId,
      });
      return c.json({ type, id, period, candles });
    } catch (error) {
      return c.json(
        {
          error: 'trade_market_kline_failed',
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

    try {
      const detail = await fetchBitgetTokenDetail(c.env, chain, contract);
      if (!detail) {
        return c.json({ error: 'token_not_found' }, 404);
      }
      let enrichedDetail = detail;
      if (!enrichedDetail.image && enrichedDetail.contract) {
        const chainId = getChainIdByMarketChain(enrichedDetail.chain);
        if (chainId != null) {
          const fallbackLogo = await resolveBestTokenCatalogLogo(c.env.DB, chainId, enrichedDetail.contract);
          if (fallbackLogo) {
            enrichedDetail = {
              ...enrichedDetail,
              image: fallbackLogo,
            };
          }
        }
      }
      return c.json({ detail: enrichedDetail });
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
      const enriched = await Promise.all(
        details.map(async (item) => {
          const detail = item.detail;
          if (!detail || detail.image || !detail.contract) {
            return item;
          }
          const chainId = getChainIdByMarketChain(detail.chain);
          if (chainId == null) {
            return item;
          }
          const fallbackLogo = await resolveBestTokenCatalogLogo(c.env.DB, chainId, detail.contract);
          if (!fallbackLogo) {
            return item;
          }
          return {
            ...item,
            detail: {
              ...detail,
              image: fallbackLogo,
            },
          };
        }),
      );
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
        shelves: 'configured_multi_shelf_with_coingecko_priority',
        tradeBrowse: {
          topMovers: 'bitget_primary',
          trendings: 'coingecko_top_volume_without_stablecoins',
          stocks: 'coingecko_tokenized_stock_category',
          perps: 'hyperliquid_info_api',
          prediction: 'polymarket_gamma_api',
        },
        tokenDetail: 'bitget_wallet_tob',
        klines: 'bitget_wallet_tob',
      },
      note: 'Top asset rankings are resolved by CoinGecko first, then fallback to Bitget. Kline and token detail remain from Bitget.',
    });
  });
}
