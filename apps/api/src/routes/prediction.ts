import type { Hono } from 'hono';
import {
  getPredictionAccount,
  getPredictionDepositInfo,
  placePredictionBet,
  type PredictionBetInput,
} from '../services/prediction';
import type { AppEnv } from '../types';
import { getErrorMessage, readJsonBody, toPredictionErrorStatus } from './routeHelpers';

export function registerPredictionRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/prediction/account', async (c) => {
    const userId = c.get('userId');
    const signatureType = c.req.query('signatureType') ?? undefined;

    try {
      const account = await getPredictionAccount(c.env, userId, {
        signatureType: signatureType as 'proxy' | 'eoa' | 'gnosis-safe' | undefined,
      });
      return c.json(account);
    } catch (error) {
      const message = getErrorMessage(error, 'prediction_account_failed');
      const status = toPredictionErrorStatus(error);
      return c.json({ error: message }, status);
    }
  });

  app.get('/v1/prediction/deposit', async (c) => {
    const userId = c.get('userId');
    try {
      const deposit = await getPredictionDepositInfo(c.env, userId);
      return c.json(deposit);
    } catch (error) {
      const message = getErrorMessage(error, 'prediction_deposit_failed');
      const status = toPredictionErrorStatus(error);
      return c.json({ error: message }, status);
    }
  });

  app.post('/v1/prediction/bet', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody<PredictionBetInput>(c.req);
    if (!body) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const result = await placePredictionBet(c.env, userId, body);
      return c.json(result);
    } catch (error) {
      const message = getErrorMessage(error, 'prediction_bet_failed');
      const status = toPredictionErrorStatus(error);
      return c.json({ error: message }, status);
    }
  });
}
