import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log } from './logger.js';

function capture(method, fn) {
  const original = console[method];
  const lines = [];
  console[method] = (line) => lines.push(line);
  try {
    fn();
  } finally {
    console[method] = original;
  }
  return lines;
}

test('info writes one JSON line to console.log', () => {
  const lines = capture('log', () => log.info('lambda', 'Invocation', { requestId: 'abc' }));
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, { level: 'info', area: 'lambda', message: 'Invocation', requestId: 'abc' });
});

test('warn writes one JSON line to console.warn', () => {
  const lines = capture('warn', () => log.warn('setup', 'missing key'));
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, { level: 'warn', area: 'setup', message: 'missing key' });
});

test('error writes one JSON line to console.error', () => {
  const lines = capture('error', () => log.error('lambda', 'Fatal error', { error: 'boom' }));
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, { level: 'error', area: 'lambda', message: 'Fatal error', error: 'boom' });
});

test('info does not write to warn or error methods', () => {
  const warnLines = capture('warn', () => {
    const errLines = capture('error', () => {
      log.info('lambda', 'hi');
    });
    assert.equal(errLines.length, 0);
  });
  assert.equal(warnLines.length, 0);
});

test('output contains no timestamp field', () => {
  const lines = capture('log', () => log.info('lambda', 'hi', { a: 1 }));
  const parsed = JSON.parse(lines[0]);
  assert.equal('timestamp' in parsed, false);
  assert.equal('time' in parsed, false);
});

test('fields merge over base but are one flat object', () => {
  const lines = capture('log', () => log.info('lambda', 'Done', { processed: 3, ok: 2 }));
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.processed, 3);
  assert.equal(parsed.ok, 2);
  assert.equal(parsed.level, 'info');
});
