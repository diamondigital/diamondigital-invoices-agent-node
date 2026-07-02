import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './retry.js';

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
