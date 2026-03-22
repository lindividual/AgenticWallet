import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapSimActivityToTransferHistoryRow,
  matchesTransferHistoryFilters,
  mergeTransferHistory,
} from '../src/services/transferHistoryRows.ts';
import type { TransferHistoryRecord } from '../src/services/transferHistoryTypes.ts';
import type { WalletSummary } from '../src/types.ts';

const wallet: WalletSummary = {
  address: '0x1111111111111111111111111111111111111111',
  provider: 'eoa-7702',
  chainAccounts: [
    {
      networkKey: 'ethereum-mainnet',
      chainId: 1,
      protocol: 'evm',
      address: '0x1111111111111111111111111111111111111111',
    },
  ],
};

function createRow(overrides: Partial<TransferHistoryRecord> = {}): TransferHistoryRecord {
  return {
    id: overrides.id ?? 'row-1',
    source: overrides.source ?? 'app',
    networkKey: overrides.networkKey ?? 'ethereum-mainnet',
    chainId: overrides.chainId ?? 1,
    fromAddress: overrides.fromAddress ?? '0x1111111111111111111111111111111111111111',
    toAddress: overrides.toAddress ?? '0x2222222222222222222222222222222222222222',
    tokenAddress: overrides.tokenAddress ?? null,
    tokenSymbol: overrides.tokenSymbol ?? 'ETH',
    tokenDecimals: overrides.tokenDecimals ?? 18,
    amountInput: overrides.amountInput ?? '1',
    amountRaw: overrides.amountRaw ?? '1000000000000000000',
    txValue: overrides.txValue ?? '1000000000000000000',
    txHash: overrides.txHash ?? '0xabc',
    status: overrides.status ?? 'confirmed',
    errorCode: overrides.errorCode ?? null,
    errorMessage: overrides.errorMessage ?? null,
    idempotencyKey: overrides.idempotencyKey ?? null,
    createdAt: overrides.createdAt ?? '2026-03-21T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-21T10:00:00.000Z',
    submittedAt: overrides.submittedAt ?? '2026-03-21T10:00:00.000Z',
    confirmedAt: overrides.confirmedAt ?? '2026-03-21T10:00:00.000Z',
  };
}

test('matchesTransferHistoryFilters supports native, symbol, and status filters', () => {
  const nativeRow = createRow();
  const erc20Row = createRow({
    id: 'row-2',
    tokenAddress: '0x3333333333333333333333333333333333333333',
    tokenSymbol: 'USDC',
    txHash: '0xdef',
    txValue: '0',
  });

  assert.equal(matchesTransferHistoryFilters(nativeRow, { limit: 10, assetType: 'native' }), true);
  assert.equal(matchesTransferHistoryFilters(erc20Row, { limit: 10, assetType: 'native' }), false);
  assert.equal(matchesTransferHistoryFilters(erc20Row, { limit: 10, tokenSymbol: 'usdc' }), true);
  assert.equal(matchesTransferHistoryFilters(erc20Row, { limit: 10, status: 'submitted' }), false);
});

test('mergeTransferHistory dedupes external rows against local rows and keeps newest results first', () => {
  const localRow = createRow({
    id: 'local',
    createdAt: '2026-03-21T11:00:00.000Z',
    updatedAt: '2026-03-21T11:00:00.000Z',
    submittedAt: '2026-03-21T11:00:00.000Z',
    confirmedAt: '2026-03-21T11:00:00.000Z',
  });
  const duplicateExternal = createRow({
    id: 'external-duplicate',
    source: 'sim',
    createdAt: '2026-03-21T12:00:00.000Z',
    updatedAt: '2026-03-21T12:00:00.000Z',
    submittedAt: '2026-03-21T12:00:00.000Z',
    confirmedAt: '2026-03-21T12:00:00.000Z',
  });
  const distinctExternal = createRow({
    id: 'external-distinct',
    source: 'sim',
    txHash: '0xghi',
    toAddress: '0x3333333333333333333333333333333333333333',
    createdAt: '2026-03-21T13:00:00.000Z',
    updatedAt: '2026-03-21T13:00:00.000Z',
    submittedAt: '2026-03-21T13:00:00.000Z',
    confirmedAt: '2026-03-21T13:00:00.000Z',
  });

  const rows = mergeTransferHistory(
    [localRow],
    [duplicateExternal, distinctExternal],
    wallet,
    { limit: 10 },
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.id, 'external-distinct');
  assert.equal(rows[1]?.id, 'local');
});

test('mapSimActivityToTransferHistoryRow normalizes native transfers and preserves wallet direction fallback', () => {
  const row = mapSimActivityToTransferHistoryRow(
    {
      chain_id: 1,
      block_time: '2026-03-21T12:00:00.000Z',
      tx_hash: '0xfeed',
      type: 'receive',
      token_address: 'native',
      value: '420000000000000000',
      from: '',
      to: '',
      token_metadata: {},
    },
    1,
    '0x1111111111111111111111111111111111111111',
    '2026-03-21T12:00:00.000Z',
  );

  assert.ok(row);
  assert.equal(row?.tokenAddress, null);
  assert.equal(row?.tokenSymbol, 'ETH');
  assert.equal(row?.toAddress, '0x1111111111111111111111111111111111111111');
  assert.equal(row?.amountInput, '0.42');
  assert.equal(row?.status, 'confirmed');
});
