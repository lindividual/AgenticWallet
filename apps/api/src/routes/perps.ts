import type { Hono } from 'hono';
import { cancelPerpsOrder, getPerpsAccountSafe, placePerpsOrder } from '../services/perps';
import type { AppEnv, PerpsCancelOrderRequest, PerpsOrderRequest } from '../types';
import { getErrorMessage, readJsonBody, toPerpsErrorStatus } from './routeHelpers';

export function registerPerpsRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/perps/account', async (c) => {
    const userId = c.get('userId');
    const snapshot = await getPerpsAccountSafe(c.env, userId);
    return c.json(snapshot);
  });

  app.post('/v1/perps/order', async (c) => {
    const userId = c.get('userId');

    const body = await readJsonBody<PerpsOrderRequest>(c.req);
    if (!body) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const result = await placePerpsOrder(c.env, userId, body);
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: getErrorMessage(error, 'perps_order_failed') },
        toPerpsErrorStatus(error),
      );
    }
  });

  app.post('/v1/perps/cancel', async (c) => {
    const userId = c.get('userId');

    const body = await readJsonBody<PerpsCancelOrderRequest>(c.req);
    if (!body) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const result = await cancelPerpsOrder(c.env, userId, body);
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: getErrorMessage(error, 'perps_cancel_failed') },
        toPerpsErrorStatus(error),
      );
    }
  });
}
