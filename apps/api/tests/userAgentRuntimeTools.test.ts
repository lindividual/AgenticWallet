import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAvailableAgentRuntimeTools,
  getRuntimeTokenContext,
  parseAgentRuntimeToolCall,
} from '../src/agent/runtimeTools.ts';

test('getAvailableAgentRuntimeTools returns token, wallet, and receive tools for matching contexts', () => {
  assert.deepEqual(
    getAvailableAgentRuntimeTools('token', {
      tokenChain: 'eth',
      tokenContract: 'native',
    }),
    ['read_token_context'],
  );

  assert.deepEqual(
    getAvailableAgentRuntimeTools('wallet', {
      receiveMode: 'true',
    }),
    ['read_wallet_context', 'read_receive_addresses'],
  );

  assert.deepEqual(
    getAvailableAgentRuntimeTools('article', {
      articleId: 'article_123',
    }),
    ['read_article'],
  );
});

test('getRuntimeTokenContext supports current and legacy token keys during transition', () => {
  assert.deepEqual(
    getRuntimeTokenContext({
      chain: 'eth',
      contract: 'native',
      symbol: 'ETH',
      tokenName: 'Ethereum',
    }),
    {
      tokenChain: 'eth',
      tokenContract: 'native',
      tokenSymbol: 'ETH',
      tokenName: 'Ethereum',
    },
  );
});

test('parseAgentRuntimeToolCall accepts only strict tool_call payloads', () => {
  const availableTools: Array<'read_token_context' | 'read_wallet_context'> = ['read_token_context', 'read_wallet_context'];

  assert.deepEqual(
    parseAgentRuntimeToolCall(
      '{"type":"tool_call","tool":"read_token_context","arguments":{"tokenChain":"eth","tokenContract":"native"}}',
      availableTools,
    ),
    {
      tool: 'read_token_context',
      arguments: {
        tokenChain: 'eth',
        tokenContract: 'native',
      },
    },
  );

  assert.equal(
    parseAgentRuntimeToolCall(
      '{"type":"final","reply":"hi","actions":[{"type":"read_token_context","arguments":{}}]}',
      availableTools,
    ),
    null,
  );

  assert.equal(
    parseAgentRuntimeToolCall(
      '{"tool":"read_token_context","arguments":{}}',
      availableTools,
    ),
    null,
  );
});
