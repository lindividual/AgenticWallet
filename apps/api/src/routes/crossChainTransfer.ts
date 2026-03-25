import type { Hono } from 'hono';
import {
  quoteCrossChainTransfer,
  submitCrossChainTransfer,
} from '../services/crossChainTransfer';
import type {
  AppEnv,
  CrossChainTransferQuoteRequest,
  CrossChainTransferSubmitRequest,
} from '../types';
import { getErrorMessage, readJsonBody, resolveErrorStatus } from './routeHelpers';

function toCrossChainTransferErrorStatus(error: unknown): 400 | 404 | 502 {
  return resolveErrorStatus(error, [
    {
      status: 400,
      equals: [
        'wallet_not_found',
        'crosschain_source_balance_not_found',
        'unsupported_crosschain_network',
        'unsupported_stablecoin_destination',
        'invalid_crosschain_sources',
        'multi_source_bridge_not_supported_yet',
      ],
      startsWith: ['invalid_', 'unsupported_crosschain_', 'crosschain_quote_http_'],
    },
  ], 502);
}

export function registerCrossChainTransferRoutes(app: Hono<AppEnv>): void {
  app.post('/v1/crosschain-transfer/quote', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody<CrossChainTransferQuoteRequest>(c.req);
    if (!body) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const quote = await quoteCrossChainTransfer(c.env, userId, body);
      return c.json(quote);
    } catch (error) {
      return c.json(
        {
          error: getErrorMessage(error, 'crosschain_transfer_quote_failed'),
        },
        toCrossChainTransferErrorStatus(error),
      );
    }
  });

  app.post('/v1/crosschain-transfer/submit', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody<CrossChainTransferSubmitRequest>(c.req);
    if (!body) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const result = await submitCrossChainTransfer(c.env, userId, body);
      return c.json(result);
    } catch (error) {
      return c.json(
        {
          error: getErrorMessage(error, 'crosschain_transfer_submit_failed'),
        },
        toCrossChainTransferErrorStatus(error),
      );
    }
  });
}
