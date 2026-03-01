import type { Hono } from 'hono';
import {
  createUserTransfer,
  getUserTransfer,
  listUserTransfers,
  updateUserTransfer,
  type AgentTransfer,
} from '../services/agent';
import {
  prepareTransfer,
  refreshTransferStatusByHash,
  sendPreparedTransfer,
  waitForTransferReceipt,
} from '../services/transfer';
import type { AppEnv, TransferQuoteRequest, TransferSubmitRequest, TransferStatus } from '../types';

const VALID_TRANSFER_STATUS = new Set<TransferStatus>(['created', 'submitted', 'confirmed', 'failed']);

function normalizeTransferStatus(raw: string | undefined): TransferStatus | undefined {
  if (!raw) return undefined;
  const value = raw.trim() as TransferStatus;
  return VALID_TRANSFER_STATUS.has(value) ? value : undefined;
}

function toApiTransfer(row: AgentTransfer) {
  return {
    id: row.id,
    chainId: row.chain_id,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    tokenAddress: row.token_address,
    tokenSymbol: row.token_symbol,
    tokenDecimals: row.token_decimals,
    amountInput: row.amount_input,
    amountRaw: row.amount_raw,
    txValue: row.tx_value,
    txHash: row.tx_hash,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
  };
}

function toErrorStatus(error: unknown): 400 | 404 | 502 {
  const message = error instanceof Error ? error.message : 'unknown_error';
  if (
    message.startsWith('invalid_') ||
    message.startsWith('insufficient_') ||
    message === 'unsupported_chain'
  ) {
    return 400;
  }
  if (message === 'wallet_not_found') {
    return 404;
  }
  return 502;
}

async function maybeRefreshSubmittedTransfer(
  env: AppEnv['Bindings'],
  userId: string,
  transfer: AgentTransfer,
): Promise<AgentTransfer> {
  if (transfer.status !== 'submitted' || !transfer.tx_hash) {
    return transfer;
  }

  const refreshed = await refreshTransferStatusByHash(env, transfer.chain_id, transfer.tx_hash as `0x${string}`);
  if (refreshed === 'pending') {
    return transfer;
  }

  const updated = await updateUserTransfer(env, userId, transfer.id, {
    status: refreshed === 'confirmed' ? 'confirmed' : 'failed',
    confirmedAt: refreshed === 'confirmed' ? new Date().toISOString() : null,
    errorCode: refreshed === 'failed' ? 'tx_reverted' : null,
    errorMessage: refreshed === 'failed' ? 'transaction reverted on chain' : null,
  });
  return updated ?? transfer;
}

export function registerTransferRoutes(app: Hono<AppEnv>): void {
  app.post('/v1/transfer/quote', async (c) => {
    const userId = c.get('userId');

    let body: TransferQuoteRequest;
    try {
      body = await c.req.json<TransferQuoteRequest>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const prepared = await prepareTransfer(c.env, userId, body);
      return c.json(prepared.quote);
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'transfer_quote_failed',
        },
        toErrorStatus(error),
      );
    }
  });

  app.post('/v1/transfer/submit', async (c) => {
    const userId = c.get('userId');

    let body: TransferSubmitRequest;
    try {
      body = await c.req.json<TransferSubmitRequest>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    try {
      const prepared = await prepareTransfer(c.env, userId, body);
      const transferId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const transferCreated = await createUserTransfer(c.env, userId, {
        id: transferId,
        chainId: prepared.quote.chainId,
        fromAddress: prepared.quote.fromAddress,
        toAddress: prepared.quote.toAddress,
        tokenAddress: prepared.quote.tokenAddress,
        tokenSymbol: prepared.quote.tokenSymbol,
        tokenDecimals: prepared.quote.tokenDecimals,
        amountInput: prepared.quote.amountInput,
        amountRaw: prepared.quote.amountRaw,
        txValue: prepared.quote.tokenAddress ? '0' : prepared.quote.amountRaw,
        status: 'created',
        idempotencyKey: body.idempotencyKey?.trim() || null,
      });

      if (transferCreated.deduped) {
        return c.json({
          transfer: toApiTransfer(transferCreated.transfer),
          deduped: true,
        });
      }

      let txHash: `0x${string}` | null = null;
      try {
        txHash = await sendPreparedTransfer(prepared);
      } catch (error) {
        const failed = await updateUserTransfer(c.env, userId, transferCreated.transfer.id, {
          status: 'failed',
          errorCode: 'transfer_submit_failed',
          errorMessage: error instanceof Error ? error.message : 'unknown_error',
        });

        return c.json(
          {
            error: error instanceof Error ? error.message : 'transfer_submit_failed',
            transfer: failed ? toApiTransfer(failed) : toApiTransfer(transferCreated.transfer),
          },
          toErrorStatus(error),
        );
      }

      const submitted = await updateUserTransfer(c.env, userId, transferCreated.transfer.id, {
        status: 'submitted',
        txHash,
        submittedAt: nowIso,
        errorCode: null,
        errorMessage: null,
      });

      const finalStatus = await waitForTransferReceipt(prepared, txHash);
      if (finalStatus === 'confirmed') {
        const confirmed = await updateUserTransfer(c.env, userId, transferCreated.transfer.id, {
          status: 'confirmed',
          confirmedAt: new Date().toISOString(),
          errorCode: null,
          errorMessage: null,
        });
        return c.json({ transfer: toApiTransfer(confirmed ?? submitted ?? transferCreated.transfer), deduped: false });
      }

      if (finalStatus === 'failed') {
        const failed = await updateUserTransfer(c.env, userId, transferCreated.transfer.id, {
          status: 'failed',
          errorCode: 'tx_reverted',
          errorMessage: 'transaction reverted on chain',
        });
        return c.json({ transfer: toApiTransfer(failed ?? submitted ?? transferCreated.transfer), deduped: false });
      }

      return c.json({ transfer: toApiTransfer(submitted ?? transferCreated.transfer), deduped: false });
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'transfer_submit_failed',
        },
        toErrorStatus(error),
      );
    }
  });

  app.get('/v1/transfer/history', async (c) => {
    const userId = c.get('userId');
    const limitRaw = Number(c.req.query('limit'));
    const status = normalizeTransferStatus(c.req.query('status'));
    const limit = Number.isFinite(limitRaw) ? limitRaw : 20;

    const rows = await listUserTransfers(c.env, userId, {
      limit,
      status,
    });

    return c.json({
      transfers: rows.map((row) => toApiTransfer(row)),
    });
  });

  app.get('/v1/transfer/:transferId', async (c) => {
    const userId = c.get('userId');
    const transferId = c.req.param('transferId');
    const transfer = await getUserTransfer(c.env, userId, transferId);

    if (!transfer) {
      return c.json({ error: 'transfer_not_found' }, 404);
    }

    const refreshed = await maybeRefreshSubmittedTransfer(c.env, userId, transfer);
    return c.json({ transfer: toApiTransfer(refreshed) });
  });
}
