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
  createTransferHistoryFilters,
  normalizeTransferHistoryStatus,
  resolveLocalTransferHistoryLimit,
} from '../services/transferHistoryFilters';
import {
  fetchExternalTransferHistory,
  mergeTransferHistory,
  type TransferHistoryRecord,
} from '../services/transferHistory';
import { tryEnsureWalletForUser } from '../services/wallet';
import type { AppEnv, TransferQuoteRequest, TransferSubmitRequest } from '../types';
import { getErrorMessage, readJsonBody, toTransferErrorStatus } from './routeHelpers';

function toApiTransfer(row: AgentTransfer): TransferHistoryRecord {
  return {
    id: row.id,
    source: 'app',
    networkKey: row.network_key,
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

async function maybeRefreshSubmittedTransfer(
  env: AppEnv['Bindings'],
  userId: string,
  transfer: AgentTransfer,
): Promise<AgentTransfer> {
  if (transfer.status !== 'submitted' || !transfer.tx_hash) {
    return transfer;
  }

  const refreshed = await refreshTransferStatusByHash(env, userId, transfer.network_key, transfer.tx_hash);
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

    const body = await readJsonBody<TransferQuoteRequest>(c.req);
    if (!body) {
      console.error('[transfer/quote] invalid_request', { requestId, userId });
      return c.json({ error: 'invalid_request' }, 400);
    }

    console.log('[transfer/quote] request', {
      requestId,
      userId,
      networkKey: body.networkKey,
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
        networkKey: prepared.quote.networkKey,
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
      const message = getErrorMessage(error, 'transfer_quote_failed');
      const status = toTransferErrorStatus(error);
      console.error('[transfer/quote] failed', {
        requestId,
        userId,
        networkKey: body.networkKey,
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

    const body = await readJsonBody<TransferSubmitRequest>(c.req);
    if (!body) {
      console.error('[transfer/submit] invalid_request', { requestId, userId });
      return c.json({ error: 'invalid_request' }, 400);
    }
    console.log('[transfer/submit] request', {
      requestId,
      userId,
      networkKey: body.networkKey,
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
        networkKey: prepared.quote.networkKey,
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

      let txHash: string | null = null;
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
            error: getErrorMessage(error, 'transfer_submit_failed'),
            transfer: failed ? toApiTransfer(failed) : toApiTransfer(transferCreated.transfer),
          },
          toTransferErrorStatus(error),
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
      const message = getErrorMessage(error, 'transfer_submit_failed');
      const status = toTransferErrorStatus(error);
      console.error('[transfer/submit] failed', {
        requestId,
        userId,
        networkKey: body.networkKey,
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
    const filters = createTransferHistoryFilters({
      limit: c.req.query('limit'),
      status: c.req.query('status'),
      networkKey: c.req.query('networkKey'),
      chainId: c.req.query('chainId'),
      tokenAddress: c.req.query('tokenAddress'),
      tokenSymbol: c.req.query('tokenSymbol'),
      assetType: c.req.query('assetType'),
    });
    const status = normalizeTransferHistoryStatus(c.req.query('status'));
    const localLimit = resolveLocalTransferHistoryLimit(filters);

    const localRows = await listUserTransfers(c.env, userId, {
      limit: localLimit,
      status,
    });
    const wallet = await tryEnsureWalletForUser(c.env, userId, 'transfer/history');
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
