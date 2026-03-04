import type { Hono } from 'hono';
import {
  buildMergedPortfolioHoldings,
  fetchWalletPortfolio,
} from '../services/market';
import { listUserPortfolioSnapshots, saveUserPortfolioSnapshot } from '../services/agent';
import { getWallet } from '../services/wallet';
import type { AppEnv } from '../types';

export function registerWalletRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/wallet/portfolio', async (c) => {
    const userId = c.get('userId');
    const wallet = await getWallet(c.env.DB, userId);
    const walletAddress = wallet?.address;

    if (!walletAddress) {
      return c.json({ error: 'wallet_not_found' }, 404);
    }

    let result;
    try {
      result = await fetchWalletPortfolio(c.env, walletAddress);
    } catch (error) {
      return c.json(
        {
          error: 'portfolio_fetch_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
    const holdings = result.holdings;
    const mergedHoldings = await buildMergedPortfolioHoldings(c.env, holdings);
    const totalUsd = result.totalUsd;
    const sample = holdings
      .slice(0, 3)
      .map((row) => `${row.chain_id}:${row.symbol ?? row.name ?? 'unknown'}:${row.amount}:$${row.value_usd ?? 'null'}`)
      .join('|');
    console.log(
      `[wallet/portfolio] sim_ok filtered=${holdings.length} totalUsd=${totalUsd} sample=${sample || 'none'}`,
    );
    await saveUserPortfolioSnapshot(c.env, userId, {
      totalUsd,
      holdings,
      asOf: result.asOf,
    });

    return c.json({
      walletAddress,
      totalUsd,
      holdings,
      mergedHoldings,
    });
  });

  app.get('/v1/wallet/portfolio/snapshots', async (c) => {
    const userId = c.get('userId');
    const periodRaw = c.req.query('period');
    const period = periodRaw === '7d' || periodRaw === '30d' ? periodRaw : '24h';
    let points = await listUserPortfolioSnapshots(c.env, userId, period);

    if (!points.length) {
      const wallet = await getWallet(c.env.DB, userId);
      const walletAddress = wallet?.address;
      if (!walletAddress) {
        return c.json({ error: 'wallet_not_found' }, 404);
      }

      const result = await fetchWalletPortfolio(c.env, walletAddress);
      await saveUserPortfolioSnapshot(c.env, userId, {
        totalUsd: result.totalUsd,
        holdings: result.holdings,
        asOf: result.asOf,
      });
      points = await listUserPortfolioSnapshots(c.env, userId, period);
    }

    return c.json({ period, points });
  });
}
