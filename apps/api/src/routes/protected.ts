import type { Hono } from 'hono';
import { isAdminApiPath, requireAdminAuth, requireAuth } from '../middleware/auth';
import { deleteSessionByToken } from '../services/session';
import { getUserSummary } from '../services/user';
import { tryEnsureWalletForUser } from '../services/wallet';
import type { AppEnv } from '../types';
import { registerAgentRoutes } from './agent';
import { registerMarketRoutes } from './market';
import { registerPaymentRoutes } from './payment';
import { registerPredictionRoutes } from './prediction';
import { registerTradeRoutes } from './trade';
import { registerTransferRoutes } from './transfer';
import { registerWalletRoutes } from './wallet';

export function registerProtectedRoutes(app: Hono<AppEnv>): void {
  app.use('/v1/admin/*', requireAdminAuth);
  app.use('/v1/*', async (c, next) => {
    if (isAdminApiPath(c.req.path)) {
      await next();
      return;
    }

    await requireAuth(c, next);
  });

  app.post('/v1/auth/logout', async (c) => {
    const token = c.get('sessionToken');
    await deleteSessionByToken(c.env.DB, token);
    return c.json({ ok: true });
  });

  app.get('/v1/me', async (c) => {
    const userId = c.get('userId');
    const user = await getUserSummary(c.env.DB, userId);
    const wallet = await tryEnsureWalletForUser(c.env, userId, 'me');

    return c.json({ user, wallet });
  });

  registerWalletRoutes(app);
  registerPredictionRoutes(app);
  registerPaymentRoutes(app);
  registerTransferRoutes(app);
  registerTradeRoutes(app);
  registerMarketRoutes(app);
  registerAgentRoutes(app);
}
