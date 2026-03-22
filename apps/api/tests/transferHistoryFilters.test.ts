import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampTransferHistoryLimit,
  createTransferHistoryFilters,
  normalizeTransferHistoryStatus,
  resolveLocalTransferHistoryLimit,
} from '../src/services/transferHistoryFilters.ts';

test('createTransferHistoryFilters normalizes supported query params', () => {
  const filters = createTransferHistoryFilters({
    limit: '250.9',
    status: ' confirmed ',
    networkKey: ' Base-Mainnet ',
    chainId: '8453.2',
    tokenAddress: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
    tokenSymbol: ' usdc ',
    assetType: 'ERC20',
  });

  assert.deepEqual(filters, {
    limit: 100,
    status: 'confirmed',
    networkKey: 'base-mainnet',
    chainId: 8453,
    tokenAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    tokenSymbol: 'USDC',
    assetType: 'erc20',
  });
});

test('createTransferHistoryFilters preserves native token intent and falls back on invalid values', () => {
  const filters = createTransferHistoryFilters({
    limit: '-1',
    status: 'not-real',
    chainId: '0',
    tokenAddress: 'native',
    tokenSymbol: '   ',
    assetType: 'weird',
  });

  assert.deepEqual(filters, {
    limit: 20,
    status: undefined,
    networkKey: undefined,
    chainId: undefined,
    tokenAddress: null,
    tokenSymbol: undefined,
    assetType: undefined,
  });
});

test('resolveLocalTransferHistoryLimit expands to 100 only for narrowed queries', () => {
  assert.equal(resolveLocalTransferHistoryLimit({ limit: 12 }), 12);
  assert.equal(resolveLocalTransferHistoryLimit({ limit: 12, tokenAddress: null }), 100);
  assert.equal(resolveLocalTransferHistoryLimit({ limit: 12, networkKey: 'ethereum-mainnet' }), 100);
});

test('normalizeTransferHistoryStatus and clampTransferHistoryLimit guard bad input', () => {
  assert.equal(normalizeTransferHistoryStatus('submitted'), 'submitted');
  assert.equal(normalizeTransferHistoryStatus(' submitted '), 'submitted');
  assert.equal(normalizeTransferHistoryStatus(' Submitted '), undefined);
  assert.equal(normalizeTransferHistoryStatus(undefined), undefined);
  assert.equal(clampTransferHistoryLimit(Number.NaN), 20);
  assert.equal(clampTransferHistoryLimit(0), 20);
  assert.equal(clampTransferHistoryLimit(8.9), 8);
  assert.equal(clampTransferHistoryLimit(300), 100);
});
