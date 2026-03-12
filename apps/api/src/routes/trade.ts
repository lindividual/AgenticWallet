import type { Hono } from 'hono';
import {
  prepareTrade,
  refreshTradeStatusByHash,
  sendPreparedTrade,
  waitForTradeReceipt,
} from '../services/trade';
import { isSolanaSignature } from '../services/solana';
import { SOLANA_NETWORK_KEY } from '../services/wallet';
import type { AppEnv, TradeQuoteRequest, TradeSubmitRequest } from '../types';

function toErrorStatus(error: unknown): 400 | 404 | 502 {
  const message = error instanceof Error ? error.message : 'unknown_error';
  const normalized = message.toLowerCase();
  if (
    message.startsWith('invalid_')
    || message.startsWith('insufficient_')
    || message === 'unsupported_chain'
    || message === 'wallet_key_decryption_failed'
    || normalized.includes('trade_provider_invalid_response')
  ) {
    return 400;
  }
  if (message === 'wallet_not_found') {
    return 404;
  }
  return 502;
}

export function registerTradeRoutes(app: Hono<AppEnv>): void {
  app.post('/v1/trade/quote', async (c) => {
    const userId = c.get('userId');
    const requestId = crypto.randomUUID();

    let body: TradeQuoteRequest;
    try {
      body = await c.req.json<TradeQuoteRequest>();
    } catch {
      console.error('[trade/quote] invalid_request', { requestId, userId });
      return c.json({ error: 'invalid_request' }, 400);
    }

    console.log('[trade/quote] request', {
      requestId,
      userId,
      networkKey: body.networkKey,
      sellTokenAddress: body.sellTokenAddress,
      buyTokenAddress: body.buyTokenAddress,
      sellAmount: body.sellAmount,
      slippageBps: body.slippageBps ?? null,
    });

    try {
      const prepared = await prepareTrade(c.env, userId, body);
      console.log('[trade/quote] success', {
        requestId,
        userId,
        networkKey: prepared.quote.networkKey,
        sellAmountRaw: prepared.quote.sellAmountRaw,
        expectedBuyAmountRaw: prepared.quote.expectedBuyAmountRaw,
        needsApproval: prepared.quote.needsApproval,
        estimatedFeeWei: prepared.quote.estimatedFeeWei,
      });
      return c.json(prepared.quote);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'trade_quote_failed';
      const status = toErrorStatus(error);
      console.error('[trade/quote] failed', {
        requestId,
        userId,
        networkKey: body.networkKey,
        sellTokenAddress: body.sellTokenAddress,
        buyTokenAddress: body.buyTokenAddress,
        sellAmount: body.sellAmount,
        status,
        error: message,
      });
      return c.json({ error: message }, status);
    }
  });

  app.post('/v1/trade/submit', async (c) => {
    const userId = c.get('userId');
    const requestId = crypto.randomUUID();

    let body: TradeSubmitRequest;
    try {
      body = await c.req.json<TradeSubmitRequest>();
    } catch {
      console.error('[trade/submit] invalid_request', { requestId, userId });
      return c.json({ error: 'invalid_request' }, 400);
    }

    console.log('[trade/submit] request', {
      requestId,
      userId,
      networkKey: body.networkKey,
      sellTokenAddress: body.sellTokenAddress,
      buyTokenAddress: body.buyTokenAddress,
      sellAmount: body.sellAmount,
      slippageBps: body.slippageBps ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
    });

    try {
      const prepared = await prepareTrade(c.env, userId, body);
      const txHash = await sendPreparedTrade(prepared);
      const status = await waitForTradeReceipt(prepared, txHash);

      console.log('[trade/submit] sent', {
        requestId,
        userId,
        networkKey: prepared.quote.networkKey,
        txHash,
        status,
      });

      return c.json({
        txHash,
        status,
        quote: prepared.quote,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'trade_submit_failed';
      const status = toErrorStatus(error);
      console.error('[trade/submit] failed', {
        requestId,
        userId,
        networkKey: body.networkKey,
        sellTokenAddress: body.sellTokenAddress,
        buyTokenAddress: body.buyTokenAddress,
        sellAmount: body.sellAmount,
        status,
        error: message,
      });
      return c.json({ error: message }, status);
    }
  });

  app.get('/v1/trade/status/:networkKey/:txHash', async (c) => {
    const networkKey = c.req.param('networkKey')?.trim().toLowerCase();
    const txHash = c.req.param('txHash') as `0x${string}`;

    const isValidHash = networkKey === SOLANA_NETWORK_KEY ? isSolanaSignature(txHash) : txHash?.startsWith('0x');
    if (!networkKey || !isValidHash) {
      return c.json({ error: 'invalid_trade_status_query' }, 400);
    }

    try {
      const status = await refreshTradeStatusByHash(c.env, networkKey, txHash);
      return c.json({ networkKey, txHash, status });
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'trade_status_failed',
        },
        502,
      );
    }
  });
}
