import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getErrorMessage,
  readJsonBody,
  toPerpsErrorStatus,
  toPredictionErrorStatus,
  toTradeErrorStatus,
  toTransferErrorStatus,
} from '../src/routes/routeHelpers.ts';

test('readJsonBody returns parsed JSON payloads', async () => {
  const request = {
    async json() {
      return { ok: true, value: 7 };
    },
  };

  assert.deepEqual(await readJsonBody<{ ok: boolean; value: number }>(request), {
    ok: true,
    value: 7,
  });
});

test('readJsonBody returns null when JSON parsing fails', async () => {
  const request = {
    async json() {
      throw new Error('bad_json');
    },
  };

  assert.equal(await readJsonBody(request), null);
});

test('getErrorMessage prefers Error.message and falls back for unknown values', () => {
  assert.equal(getErrorMessage(new Error('known_error'), 'fallback_error'), 'known_error');
  assert.equal(getErrorMessage({ message: 'ignored' }, 'fallback_error'), 'fallback_error');
});

test('toTradeErrorStatus preserves trade route status rules', () => {
  assert.equal(toTradeErrorStatus(new Error('invalid_trade_amount')), 400);
  assert.equal(toTradeErrorStatus(new Error('wallet_not_found')), 404);
  assert.equal(toTradeErrorStatus(new Error('Trade_Provider_Invalid_Response: malformed quote')), 400);
  assert.equal(toTradeErrorStatus(new Error('upstream_timeout')), 502);
});

test('toTransferErrorStatus preserves transfer route status rules', () => {
  assert.equal(toTransferErrorStatus(new Error('invalid_transfer_amount')), 400);
  assert.equal(toTransferErrorStatus(new Error('wallet_not_found')), 404);
  assert.equal(
    toTransferErrorStatus(new Error('Insufficient balance to pay for the gas on destination chain')),
    400,
  );
  assert.equal(toTransferErrorStatus(new Error('unexpected_submit_failure')), 502);
});

test('toPerpsErrorStatus preserves perps route status rules', () => {
  assert.equal(toPerpsErrorStatus(new Error('invalid_perps_size')), 400);
  assert.equal(toPerpsErrorStatus(new Error('wallet_key_decryption_failed')), 400);
  assert.equal(toPerpsErrorStatus(new Error('exchange_unavailable')), 502);
});

test('toPredictionErrorStatus preserves prediction route status rules', () => {
  assert.equal(toPredictionErrorStatus(new Error('unsupported_prediction_market')), 400);
  assert.equal(toPredictionErrorStatus(new Error('prediction_order_rejected_by_market')), 400);
  assert.equal(toPredictionErrorStatus(new Error('wallet_not_found')), 404);
  assert.equal(toPredictionErrorStatus(new Error('prediction_provider_timeout')), 502);
});
