import type { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { getUserSummary } from '../services/user';
import { getWallet } from '../services/wallet';
import type { AppEnv } from '../types';
import { registerAgentRoutes } from './agent';
import { registerMarketRoutes } from './market';
import { registerPaymentRoutes } from './payment';
import { registerTransferRoutes } from './transfer';
import { registerWalletRoutes } from './wallet';

export function registerProtectedRoutes(app: Hono<AppEnv>): void {
  app.use('/v1/*', requireAuth);

  app.get('/v1/me', async (c) => {
    const userId = c.get('userId');
    const user = await getUserSummary(c.env.DB, userId);
    const wallet = await getWallet(c.env.DB, userId);

    return c.json({ user, wallet });
  });

  registerWalletRoutes(app);
  registerPaymentRoutes(app);
  registerTransferRoutes(app);
  registerMarketRoutes(app);
  registerAgentRoutes(app);
}
