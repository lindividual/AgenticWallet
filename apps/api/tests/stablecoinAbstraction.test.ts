import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStablecoinTransferPlan,
  getStablecoinNetworkAsset,
  type StablecoinBalance,
} from '../src/services/stablecoinAbstraction.ts';

function convertAmountDecimals(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value;
  if (fromDecimals < toDecimals) {
    return value * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return value / 10n ** BigInt(fromDecimals - toDecimals);
}

function createBalance(
  networkKey: string,
  symbol: 'USDT' | 'USDC',
  amountRaw: bigint,
  fromAddress = '0x1111111111111111111111111111111111111111',
): StablecoinBalance {
  const asset = getStablecoinNetworkAsset(networkKey, symbol);
  if (!asset) {
    throw new Error(`missing_asset:${networkKey}:${symbol}`);
  }
  return {
    ...asset,
    availableAmountRaw: amountRaw,
    fromAddress,
  };
}

test('buildStablecoinTransferPlan returns direct when destination balance covers the amount', () => {
  const plan = buildStablecoinTransferPlan({
    destinationNetworkKey: 'arbitrum-mainnet',
    destinationTokenSymbol: 'USDT',
    requestedAmountRaw: 100_000_000n,
    availableSources: [
      createBalance('arbitrum-mainnet', 'USDT', 200_000_000n),
      createBalance('ethereum-mainnet', 'USDT', 500_000_000n),
    ],
  });

  assert.equal(plan.executionMode, 'direct');
  assert.equal(plan.selectedSourceNetworkKey, 'arbitrum-mainnet');
  assert.equal(plan.selectedSources.length, 1);
  assert.equal(plan.selectedSources[0]?.selectedAmountRaw, 100_000_000n);
});

test('buildStablecoinTransferPlan returns single_source_bridge when one non-destination source can fully cover', () => {
  const plan = buildStablecoinTransferPlan({
    destinationNetworkKey: 'arbitrum-mainnet',
    destinationTokenSymbol: 'USDT',
    requestedAmountRaw: 100_000_000n,
    availableSources: [
      createBalance('arbitrum-mainnet', 'USDT', 20_000_000n),
      createBalance('ethereum-mainnet', 'USDT', 150_000_000n),
      createBalance('bnb-mainnet', 'USDT', 80_000_000n),
    ],
  });

  assert.equal(plan.executionMode, 'single_source_bridge');
  assert.equal(plan.selectedSourceNetworkKey, 'ethereum-mainnet');
  assert.equal(plan.selectedSources.length, 1);
  assert.equal(plan.selectedSources[0]?.networkKey, 'ethereum-mainnet');
  assert.equal(plan.selectedSources[0]?.selectedAmountRaw, 100_000_000n);
});

test('buildStablecoinTransferPlan returns multi_source_bridge when multiple sources are required', () => {
  const plan = buildStablecoinTransferPlan({
    destinationNetworkKey: 'arbitrum-mainnet',
    destinationTokenSymbol: 'USDT',
    requestedAmountRaw: 100_000_000n,
    availableSources: [
      createBalance('arbitrum-mainnet', 'USDT', 20_000_000n),
      createBalance('ethereum-mainnet', 'USDT', 60_000_000n),
      createBalance('bnb-mainnet', 'USDT', 40_000_000_000_000_000_000n),
    ],
  });

  assert.equal(plan.executionMode, 'multi_source_bridge');
  assert.equal(plan.selectedSourceNetworkKey, null);
  assert.equal(plan.selectedSources.length >= 2, true);
  assert.equal(
    plan.selectedSources.reduce(
      (acc, item) => acc + convertAmountDecimals(item.selectedAmountRaw, item.tokenDecimals, plan.destination.tokenDecimals),
      0n,
    ),
    100_000_000n,
  );
});

test('buildStablecoinTransferPlan returns insufficient_balance when aggregate balance is not enough', () => {
  const plan = buildStablecoinTransferPlan({
    destinationNetworkKey: 'arbitrum-mainnet',
    destinationTokenSymbol: 'USDT',
    requestedAmountRaw: 200_000_000n,
    availableSources: [
      createBalance('arbitrum-mainnet', 'USDT', 20_000_000n),
      createBalance('ethereum-mainnet', 'USDT', 60_000_000n),
    ],
  });

  assert.equal(plan.executionMode, 'insufficient_balance');
  assert.equal(plan.estimatedReceivedAmountRaw, 80_000_000n);
  assert.equal(plan.shortfallAmountRaw, 120_000_000n);
});

test('buildStablecoinTransferPlan respects an explicit source network override', () => {
  const plan = buildStablecoinTransferPlan({
    destinationNetworkKey: 'arbitrum-mainnet',
    destinationTokenSymbol: 'USDT',
    requestedAmountRaw: 100_000_000n,
    sourceNetworkKey: 'bnb-mainnet',
    availableSources: [
      createBalance('ethereum-mainnet', 'USDT', 200_000_000n),
      createBalance('bnb-mainnet', 'USDT', 150_000_000_000_000_000_000n),
    ],
  });

  assert.equal(plan.executionMode, 'single_source_bridge');
  assert.equal(plan.selectedSourceNetworkKey, 'bnb-mainnet');
  assert.equal(plan.availableSources.length, 1);
});
