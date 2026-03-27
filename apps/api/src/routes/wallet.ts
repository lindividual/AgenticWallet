import type { Hono } from 'hono';
import {
  buildMergedPortfolioHoldings,
  fetchWalletPortfolio,
} from '../services/market';
import { getFiat24CardSafe } from '../services/fiat24';
import { getPerpsAccountSafe } from '../services/perps';
import { listUserPortfolioSnapshots, saveUserPortfolioSnapshot } from '../services/agent';
import { getPredictionAccountSafe } from '../services/prediction';
import { ensureWalletForUser } from '../services/wallet';
import type { AppEnv } from '../types';

export function registerWalletRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/wallet/portfolio', async (c) => {
    const userId = c.get('userId');
    const wallet = await ensureWalletForUser(c.env, userId);
    const walletAddress = wallet?.address;

    if (!walletAddress || !wallet) {
      return c.json({ error: 'wallet_not_found' }, 404);
    }

    let result;
    try {
      result = await fetchWalletPortfolio(c.env, wallet);
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
    const [mergedHoldings, perpsAccount, predictionAccount, fiat24Card] = await Promise.all([
      buildMergedPortfolioHoldings(c.env, holdings),
      getPerpsAccountSafe(c.env, userId),
      getPredictionAccountSafe(c.env, userId, {
        signatureType: 'eoa',
      }),
      getFiat24CardSafe(c.env, wallet),
    ]);
    const totalUsd = result.totalUsd;
    const sample = holdings
      .slice(0, 3)
      .map((row) => `${row.chain_id}:${row.symbol ?? row.name ?? 'unknown'}:${row.amount}:$${row.value_usd ?? 'null'}`)
      .join('|');
    console.log(
      `[wallet/portfolio] sim_ok filtered=${holdings.length} totalUsd=${totalUsd} sample=${sample || 'none'}`,
    );
    return c.json({
      walletAddress,
      totalUsd,
      holdings,
      mergedHoldings,
      perpsAccount,
      predictionAccount,
      fiat24Card,
    });
  });

  app.get('/v1/wallet/portfolio/snapshots', async (c) => {
    const userId = c.get('userId');
    const periodRaw = c.req.query('period');
    const period = periodRaw === '7d' || periodRaw === '30d' ? periodRaw : '24h';
    let points = await listUserPortfolioSnapshots(c.env, userId, period);

    if (!points.length) {
      const wallet = await ensureWalletForUser(c.env, userId);
      const walletAddress = wallet?.address;
      if (!walletAddress || !wallet) {
        return c.json({ error: 'wallet_not_found' }, 404);
      }

      const result = await fetchWalletPortfolio(c.env, wallet);
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
