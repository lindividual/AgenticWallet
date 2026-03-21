import type { Hono } from 'hono';
import { cancelPerpsOrder, getPerpsAccountSafe, placePerpsOrder } from '../services/perps';
import type { AppEnv, PerpsCancelOrderRequest, PerpsOrderRequest } from '../types';

function toPerpsErrorStatus(error: unknown): 400 | 502 {
  const message = error instanceof Error ? error.message : 'perps_request_failed';
  if (
    message.startsWith('invalid_')
    || message.startsWith('perps_cross_margin_unsupported')
    || message === 'wallet_key_decryption_failed'
  ) {
    return 400;
  }
  return 502;
}

export function registerPerpsRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/perps/account', async (c) => {
    const userId = c.get('userId');
    const snapshot = await getPerpsAccountSafe(c.env, userId);
    return c.json(snapshot);
  });

  app.post('/v1/perps/order', async (c) => {
    const userId = c.get('userId');

    let body: PerpsOrderRequest;
    try {
      body = await c.req.json<PerpsOrderRequest>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const result = await placePerpsOrder(c.env, userId, body);
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'perps_order_failed' },
        toPerpsErrorStatus(error),
      );
    }
  });

  app.post('/v1/perps/cancel', async (c) => {
    const userId = c.get('userId');

    let body: PerpsCancelOrderRequest;
    try {
      body = await c.req.json<PerpsCancelOrderRequest>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const result = await cancelPerpsOrder(c.env, userId, body);
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'perps_cancel_failed' },
        toPerpsErrorStatus(error),
      );
    }
  });
}
