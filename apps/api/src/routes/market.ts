import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ingestTokenLists, listTokenCatalog } from '../services/market';
import { fetchBitgetTokenDetail, fetchBitgetTokenKline, fetchBitgetTopMarketAssets } from '../services/bitgetWallet';

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
    const name = c.req.query('name') ?? 'topGainers';
    const chainsRaw = c.req.query('chains') ?? '';
    const chains = chainsRaw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    try {
      const assets = await fetchBitgetTopMarketAssets(c.env, {
        name,
        limit,
        chains,
      });
      return c.json({ assets });
    } catch (error) {
      return c.json(
        {
          error: 'bitget_top_assets_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/market/token-detail', async (c) => {
    const chain = (c.req.query('chain') ?? '').trim();
    const contract = (c.req.query('contract') ?? '').trim();
    if (!chain) {
      return c.json({ error: 'invalid_chain' }, 400);
    }

    try {
      const detail = await fetchBitgetTokenDetail(c.env, chain, contract);
      if (!detail) {
        return c.json({ error: 'token_not_found' }, 404);
      }
      return c.json({ detail });
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

  app.get('/v1/market/kline', async (c) => {
    const chain = (c.req.query('chain') ?? '').trim();
    const contract = (c.req.query('contract') ?? '').trim();
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
        mode: 'signed_rest',
        providers: [
          {
            name: 'bitget_wallet_tob',
            rest: 'https://bopenapi.bgwapi.io/bgw-pro/market/v3/topRank/detail',
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
      note: 'Backend proxies Bitget Wallet ToB market/token/kline APIs.',
    });
  });
}
