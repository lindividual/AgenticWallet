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
import {
  fetchExternalTransferHistory,
  mergeTransferHistory,
  type TransferHistoryFilters,
  type TransferHistoryRecord,
} from '../services/transferHistory';
import { getWallet } from '../services/wallet';
import type { AppEnv, TransferQuoteRequest, TransferSubmitRequest, TransferStatus } from '../types';

const VALID_TRANSFER_STATUS = new Set<TransferStatus>(['created', 'submitted', 'confirmed', 'failed']);

function normalizeTransferStatus(raw: string | undefined): TransferStatus | undefined {
  if (!raw) return undefined;
  const value = raw.trim() as TransferStatus;
  return VALID_TRANSFER_STATUS.has(value) ? value : undefined;
}

function normalizeHistoryLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

function normalizeChainId(raw: string | undefined): number | undefined {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function normalizeTokenAddress(raw: string | undefined): string | null | undefined {
  if (raw == null) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'native' || value === '0x0000000000000000000000000000000000000000') return null;
  return /^0x[a-f0-9]{40}$/.test(value) ? value : undefined;
}

function normalizeTokenSymbol(raw: string | undefined): string | undefined {
  const value = raw?.trim().toUpperCase();
  return value || undefined;
}

function normalizeAssetType(raw: string | undefined): TransferHistoryFilters['assetType'] | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === 'native' || value === 'erc20') return value;
  return undefined;
}

function toApiTransfer(row: AgentTransfer): TransferHistoryRecord {
  return {
    id: row.id,
    source: 'app',
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
  const normalizedMessage = message.toLowerCase();
  if (
    message.startsWith('invalid_') ||
    message.startsWith('insufficient_') ||
    message === 'unsupported_fee_token' ||
    normalizedMessage.includes('insufficient balance to pay for the gas') ||
    normalizedMessage.includes('orchestration fee') ||
    message === 'unsupported_chain' ||
    message === 'wallet_key_decryption_failed'
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

  const refreshed = await refreshTransferStatusByHash(env, userId, transfer.chain_id, transfer.tx_hash as `0x${string}`);
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
    const requestId = crypto.randomUUID();

    let body: TransferQuoteRequest;
    try {
      body = await c.req.json<TransferQuoteRequest>();
    } catch {
      console.error('[transfer/quote] invalid_request', { requestId, userId });
      return c.json({ error: 'invalid_request' }, 400);
    }

    console.log('[transfer/quote] request', {
      requestId,
      userId,
      chainId: body.chainId,
      toAddress: body.toAddress,
      amount: body.amount,
      tokenAddress: body.tokenAddress ?? null,
      tokenSymbol: body.tokenSymbol ?? null,
      tokenDecimals: body.tokenDecimals ?? null,
    });

    try {
      const prepared = await prepareTransfer(c.env, userId, body);
      console.log('[transfer/quote] success', {
        requestId,
        userId,
        chainId: prepared.quote.chainId,
        fromAddress: prepared.quote.fromAddress,
        toAddress: prepared.quote.toAddress,
        tokenAddress: prepared.quote.tokenAddress,
        tokenSymbol: prepared.quote.tokenSymbol,
        tokenDecimals: prepared.quote.tokenDecimals,
        amountInput: prepared.quote.amountInput,
        amountRaw: prepared.quote.amountRaw,
        estimatedFeeWei: prepared.quote.estimatedFeeWei,
        estimatedFeeTokenAmount: prepared.quote.estimatedFeeTokenAmount,
        estimatedFeeTokenWei: prepared.quote.estimatedFeeTokenWei,
        estimatedFeeTokenAddress: prepared.quote.estimatedFeeTokenAddress,
        estimatedFeeTokenChainId: prepared.quote.estimatedFeeTokenChainId,
        insufficientFeeTokenBalance: prepared.quote.insufficientFeeTokenBalance,
      });
      return c.json(prepared.quote);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'transfer_quote_failed';
      const status = toErrorStatus(error);
      console.error('[transfer/quote] failed', {
        requestId,
        userId,
        chainId: body.chainId,
        toAddress: body.toAddress,
        tokenAddress: body.tokenAddress ?? null,
        tokenSymbol: body.tokenSymbol ?? null,
        tokenDecimals: body.tokenDecimals ?? null,
        amount: body.amount,
        status,
        error: message,
      });
      return c.json(
        {
          error: message,
        },
        status,
      );
    }
  });

  app.post('/v1/transfer/submit', async (c) => {
    const userId = c.get('userId');
    const requestId = crypto.randomUUID();

    let body: TransferSubmitRequest;
    try {
      body = await c.req.json<TransferSubmitRequest>();
    } catch {
      console.error('[transfer/submit] invalid_request', { requestId, userId });
      return c.json({ error: 'invalid_request' }, 400);
    }
    console.log('[transfer/submit] request', {
      requestId,
      userId,
      chainId: body.chainId,
      toAddress: body.toAddress,
      amount: body.amount,
      tokenAddress: body.tokenAddress ?? null,
      tokenSymbol: body.tokenSymbol ?? null,
      tokenDecimals: body.tokenDecimals ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
    });

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
        console.log('[transfer/submit] deduped', {
          requestId,
          userId,
          transferId: transferCreated.transfer.id,
        });
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
        console.log('[transfer/submit] confirmed', {
          requestId,
          userId,
          transferId: transferCreated.transfer.id,
          txHash,
        });
        return c.json({ transfer: toApiTransfer(confirmed ?? submitted ?? transferCreated.transfer), deduped: false });
      }

      if (finalStatus === 'failed') {
        const failed = await updateUserTransfer(c.env, userId, transferCreated.transfer.id, {
          status: 'failed',
          errorCode: 'tx_reverted',
          errorMessage: 'transaction reverted on chain',
        });
        console.error('[transfer/submit] onchain_failed', {
          requestId,
          userId,
          transferId: transferCreated.transfer.id,
          txHash,
        });
        return c.json({ transfer: toApiTransfer(failed ?? submitted ?? transferCreated.transfer), deduped: false });
      }

      console.log('[transfer/submit] submitted_pending', {
        requestId,
        userId,
        transferId: transferCreated.transfer.id,
        txHash,
      });
      return c.json({ transfer: toApiTransfer(submitted ?? transferCreated.transfer), deduped: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'transfer_submit_failed';
      const status = toErrorStatus(error);
      console.error('[transfer/submit] failed', {
        requestId,
        userId,
        chainId: body.chainId,
        toAddress: body.toAddress,
        tokenAddress: body.tokenAddress ?? null,
        tokenSymbol: body.tokenSymbol ?? null,
        tokenDecimals: body.tokenDecimals ?? null,
        amount: body.amount,
        status,
        error: message,
      });
      return c.json(
        {
          error: message,
        },
        status,
      );
    }
  });

  app.get('/v1/transfer/history', async (c) => {
    const userId = c.get('userId');
    const status = normalizeTransferStatus(c.req.query('status'));
    const filters: TransferHistoryFilters = {
      limit: normalizeHistoryLimit(c.req.query('limit')),
      status,
      chainId: normalizeChainId(c.req.query('chainId')),
      tokenAddress: normalizeTokenAddress(c.req.query('tokenAddress')),
      tokenSymbol: normalizeTokenSymbol(c.req.query('tokenSymbol')),
      assetType: normalizeAssetType(c.req.query('assetType')),
    };
    const localLimit = filters.chainId || filters.tokenAddress !== undefined || filters.tokenSymbol || filters.assetType
      ? 100
      : filters.limit;

    const localRows = await listUserTransfers(c.env, userId, {
      limit: localLimit,
      status,
    });
    const wallet = await getWallet(c.env.DB, userId);
    const externalRows = status && status !== 'confirmed'
      ? []
      : await fetchExternalTransferHistory(c.env, wallet, filters);
    const rows = mergeTransferHistory(
      localRows.map((row) => toApiTransfer(row)),
      externalRows,
      wallet,
      filters,
    );

    return c.json({
      transfers: rows,
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
