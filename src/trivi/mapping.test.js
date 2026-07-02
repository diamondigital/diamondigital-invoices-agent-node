import test from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_TYPE_CODES, paymentTypeFromMethod } from './mapping.js';

test('PAYMENT_TYPE_CODES maps known methods to TRIVI numeric enum', () => {
  assert.deepEqual(PAYMENT_TYPE_CODES, { bank_transfer: 1, cash: 2, cod: 3, card: 4 });
});

test('paymentTypeFromMethod returns the code for each known method', () => {
  assert.equal(paymentTypeFromMethod('bank_transfer'), 1);
  assert.equal(paymentTypeFromMethod('cash'), 2);
  assert.equal(paymentTypeFromMethod('cod'), 3);
  assert.equal(paymentTypeFromMethod('card'), 4);
});

test('paymentTypeFromMethod returns undefined for unknown method', () => {
  assert.equal(paymentTypeFromMethod('unknown'), undefined);
});

test('paymentTypeFromMethod returns undefined for missing/null input', () => {
  assert.equal(paymentTypeFromMethod(), undefined);
  assert.equal(paymentTypeFromMethod(undefined), undefined);
  assert.equal(paymentTypeFromMethod(null), undefined);
});

test('paymentTypeFromMethod returns undefined for unrecognized string', () => {
  assert.equal(paymentTypeFromMethod('bitcoin'), undefined);
});
