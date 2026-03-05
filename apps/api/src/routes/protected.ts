import type { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { deleteSessionByToken } from '../services/session';
import { getUserSummary } from '../services/user';
import { getWallet } from '../services/wallet';
import type { AppEnv } from '../types';
import { registerAgentRoutes } from './agent';
import { registerAssetRoutes } from './assets';
import { registerMarketRoutes } from './market';
import { registerPaymentRoutes } from './payment';
import { registerPredictionRoutes } from './prediction';
import { registerTradeRoutes } from './trade';
import { registerTransferRoutes } from './transfer';
import { registerWalletRoutes } from './wallet';

export function registerProtectedRoutes(app: Hono<AppEnv>): void {
  app.use('/v1/*', requireAuth);

  app.post('/v1/auth/logout', async (c) => {
    const token = c.get('sessionToken');
    await deleteSessionByToken(c.env.DB, token);
    return c.json({ ok: true });
  });

  app.get('/v1/me', async (c) => {
    const userId = c.get('userId');
    const user = await getUserSummary(c.env.DB, userId);
    const wallet = await getWallet(c.env.DB, userId);

    return c.json({ user, wallet });
  });

  registerWalletRoutes(app);
  registerPredictionRoutes(app);
  registerPaymentRoutes(app);
  registerTransferRoutes(app);
  registerTradeRoutes(app);
  registerMarketRoutes(app);
  registerAssetRoutes(app);
  registerAgentRoutes(app);
}
