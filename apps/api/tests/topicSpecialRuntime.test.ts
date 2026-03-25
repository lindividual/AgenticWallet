import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTopicArticleRuntimeStep } from '../src/services/topicSpecialRuntime.ts';

test('parseTopicArticleRuntimeStep accepts registered tool calls only', () => {
  const parsed = parseTopicArticleRuntimeStep(
    '{"type":"tool_call","tool":"read_news_signals","arguments":{"query":"solana","limit":"4"}}',
    ['read_news_signals', 'read_source_refs'],
  );

  assert.equal(parsed.kind, 'tool_call');
  if (parsed.kind !== 'tool_call') return;
  assert.equal(parsed.toolCall.tool, 'read_news_signals');
  assert.deepEqual(parsed.toolCall.arguments, {
    query: 'solana',
    limit: '4',
  });
});

test('parseTopicArticleRuntimeStep accepts final markdown payloads', () => {
  const parsed = parseTopicArticleRuntimeStep(
    '{"type":"final","markdown":"# Headline\\n\\nBody"}',
    ['read_news_signals'],
  );

  assert.deepEqual(parsed, {
    kind: 'final',
    markdown: '# Headline\n\nBody',
  });
});

test('parseTopicArticleRuntimeStep falls back to plain markdown for invalid tool payloads', () => {
  const parsed = parseTopicArticleRuntimeStep(
    '```json\n{"type":"tool_call","tool":"read_wallet_context","arguments":{}}\n```',
    ['read_news_signals'],
  );

  assert.deepEqual(parsed, {
    kind: 'final',
    markdown: '{"type":"tool_call","tool":"read_wallet_context","arguments":{}}',
  });
});
