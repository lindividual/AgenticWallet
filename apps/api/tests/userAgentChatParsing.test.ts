import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAgentChatPayload } from '../src/agent/chatParsing.ts';

test('normalizeAgentChatPayload normalizes a direct transfer_preview action into actions', () => {
  const result = normalizeAgentChatPayload({
    type: 'transfer_preview',
    networkKey: 'bnb-mainnet',
    toAddress: '0xeeB497998a6DC17e7A974fD144d9C862E4619454',
    amount: '0.1',
    tokenSymbol: 'USDT',
    tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    tokenDecimals: 18,
  });

  assert.ok(result);
  assert.equal(result.reply, '');
  assert.deepEqual(result.actions, [
    {
      type: 'transfer_preview',
      networkKey: 'bnb-mainnet',
      toAddress: '0xeeB497998a6DC17e7A974fD144d9C862E4619454',
      amount: '0.1',
      tokenSymbol: 'USDT',
      tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
      tokenDecimals: 18,
    },
  ]);
});

test('normalizeAgentChatPayload preserves action-only final payloads without forcing reply text', () => {
  const result = normalizeAgentChatPayload({
    type: 'final',
    actions: [{ type: 'quick_replies', options: [{ label: '确认', message: '确认这笔转账' }] }],
  });

  assert.ok(result);
  assert.equal(result.reply, '');
  assert.deepEqual(result.actions, [
    {
      type: 'quick_replies',
      options: [
        {
          label: '确认',
          message: '确认这笔转账',
        },
      ],
    },
  ]);
});
