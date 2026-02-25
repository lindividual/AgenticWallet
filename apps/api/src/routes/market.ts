import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ingestTokenLists, listTokenCatalog } from '../services/market';

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

  app.get('/v1/market/sources', (c) => {
    return c.json({
      realtime: {
        mode: 'direct_ws',
        providers: [
          {
            name: 'binance',
            ws: 'wss://stream.binance.com:9443/ws/<symbol>@ticker',
          },
        ],
      },
      klines: {
        mode: 'direct_rest_polling',
        providers: [
          {
            name: 'binance',
            rest: 'https://api.binance.com/api/v3/klines?symbol=<symbol>&interval=1h&limit=<n>',
          },
          {
            name: 'coingecko_onchain',
            rest:
              'https://pro-api.coingecko.com/api/v3/onchain/networks/<network>/tokens/<token_address>/ohlcv/<timeframe>',
          },
        ],
      },
      note: 'Backend does not persist kline or realtime prices.',
    });
  });
}
