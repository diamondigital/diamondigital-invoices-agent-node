import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, defaultShouldRetry } from './retry.js';

function httpError(status) {
  const err = new Error(`HTTP ${status}`);
  err.response = { status };
  return err;
}

test('withRetry returns the result on first success', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; return 'ok'; }, { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(await fn(), 'ok');
  assert.equal(calls, 1);
});

test('withRetry recovers after transient failures', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; if (calls < 3) throw new Error('boom'); return 'ok'; },
    { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(await fn(), 'ok');
  assert.equal(calls, 3);
});

test('withRetry throws after exhausting attempts', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; throw new Error('always'); }, { maxAttempts: 3, baseDelayMs: 1 });
  await assert.rejects(() => fn(), /always/);
  assert.equal(calls, 3);
});

test('withRetry does not retry non-retryable 4xx (called once)', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; throw httpError(400); }, { maxAttempts: 3, baseDelayMs: 1 });
  await assert.rejects(() => fn(), /HTTP 400/);
  assert.equal(calls, 1);
});

test('withRetry retries on retryable 5xx', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; if (calls < 3) throw httpError(500); return 'ok'; },
    { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(await fn(), 'ok');
  assert.equal(calls, 3);
});

test('withRetry retries on network error (no response)', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; if (calls < 3) throw new Error('ECONNRESET'); return 'ok'; },
    { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(await fn(), 'ok');
  assert.equal(calls, 3);
});

test('withRetry retries on 429 rate limit', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; if (calls < 2) throw httpError(429); return 'ok'; },
    { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(await fn(), 'ok');
  assert.equal(calls, 2);
});

test('withRetry honors a custom shouldRetry override', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; throw httpError(400); },
    { maxAttempts: 3, baseDelayMs: 1, shouldRetry: () => true });
  await assert.rejects(() => fn(), /HTTP 400/);
  assert.equal(calls, 3);
});

test('defaultShouldRetry retries network errors and >=500 and 429, not other 4xx', () => {
  assert.equal(defaultShouldRetry(new Error('network')), true);
  assert.equal(defaultShouldRetry(undefined), true);
  assert.equal(defaultShouldRetry(httpError(500)), true);
  assert.equal(defaultShouldRetry(httpError(503)), true);
  assert.equal(defaultShouldRetry(httpError(429)), true);
  assert.equal(defaultShouldRetry(httpError(400)), false);
  assert.equal(defaultShouldRetry(httpError(401)), false);
  assert.equal(defaultShouldRetry(httpError(403)), false);
  assert.equal(defaultShouldRetry(httpError(404)), false);
  assert.equal(defaultShouldRetry(httpError(422)), false);
});
