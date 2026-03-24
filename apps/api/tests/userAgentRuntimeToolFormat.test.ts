import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReceiveAddressesToolResult,
  buildTokenContextToolResult,
  buildWalletContextToolResult,
  summarizeKlineTrend,
} from '../src/agent/runtimeToolFormat.ts';

test('summarizeKlineTrend and token tool formatting degrade safely when upstream data is partial', () => {
  const trend = summarizeKlineTrend([
    { time: 1, open: 100, high: 102, low: 99, close: 101 },
    { time: 2, open: 101, high: 105, low: 100, close: 104 },
    { time: 3, open: 104, high: 106, low: 103, close: 105 },
  ]);
  assert.match(trend, /upward|strong upward|sideways/);

  const result = buildTokenContextToolResult({
    requestedChain: 'eth',
    requestedContract: 'native',
    requestedSymbol: 'ETH',
    requestedName: 'Ethereum',
    detail: null,
    audit: null,
    candles: [],
    isInWatchlist: false,
    holding: null,
  });

  assert.match(result, /Tool result for read_token_context/);
  assert.match(result, /Risk audit: unavailable/);
  assert.match(result, /Trend summary: Trend summary unavailable/);
  assert.match(result, /User position: none detected/);
});

test('buildWalletContextToolResult includes top holdings and recent summaries', () => {
  const result = buildWalletContextToolResult({
    walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    chainAccounts: [
      {
        networkKey: 'ethereum-mainnet',
        protocol: 'evm',
        address: '0x1234567890abcdef1234567890abcdef12345678',
      },
      {
        networkKey: 'solana-mainnet',
        protocol: 'svm',
        address: 'So11111111111111111111111111111111111111112',
      },
    ],
    totalUsd: 12500,
    topHoldings: [
      { symbol: 'ETH', name: 'Ethereum', valueUsd: 6000, portfolioWeightPct: 48 },
      { symbol: 'USDC', name: 'USD Coin', valueUsd: 3000, portfolioWeightPct: 24 },
    ],
    watchlistSymbols: ['ETH', 'SOL'],
    recentEventTypes: ['asset_viewed', 'article_opened'],
  });

  assert.match(result, /Portfolio total: \$12.50K/);
  assert.match(result, /Top holdings: ETH/);
  assert.match(result, /Watchlist summary: ETH, SOL/);
  assert.match(result, /Recent activity summary: asset_viewed, article_opened/);
});

test('buildReceiveAddressesToolResult groups protocol addresses explicitly', () => {
  const result = buildReceiveAddressesToolResult({
    groups: [
      {
        protocol: 'evm',
        label: 'EVM receive address',
        address: '0x1234567890abcdef1234567890abcdef12345678',
        chainNames: ['Ethereum', 'Base', 'BNB Chain'],
      },
      {
        protocol: 'tvm',
        label: 'Tron receive address',
        address: 'TXYz1234567890',
        chainNames: ['Tron'],
      },
      {
        protocol: 'svm',
        label: 'Solana receive address',
        address: 'So11111111111111111111111111111111111111112',
        chainNames: ['Solana'],
      },
      {
        protocol: 'btc',
        label: 'Bitcoin receive address',
        address: 'bc1qexampleaddress',
        chainNames: ['Bitcoin'],
      },
    ],
  });

  assert.match(result, /EVM receive address: address=0x1234567890abcdef1234567890abcdef12345678; supported chains=Ethereum, Base, BNB Chain/);
  assert.match(result, /Tron receive address: address=TXYz1234567890; supported chains=Tron/);
  assert.match(result, /Solana receive address: address=So11111111111111111111111111111111111111112; supported chains=Solana/);
  assert.match(result, /Bitcoin receive address: address=bc1qexampleaddress; supported chains=Bitcoin/);
});
