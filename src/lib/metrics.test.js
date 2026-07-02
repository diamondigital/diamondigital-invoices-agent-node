import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitMetrics } from './metrics.js';

function capture(fn) {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

test('emitMetrics returns valid EMF object with fixed timestamp', () => {
  let out;
  capture(() => {
    out = emitMetrics({ processed: 3, successful: 2, skipped: 1, failed: 0 }, 1700000000000);
  });

  assert.ok(out._aws);
  assert.equal(out._aws.Timestamp, 1700000000000);
  assert.ok(Array.isArray(out._aws.CloudWatchMetrics));
  assert.equal(out._aws.CloudWatchMetrics.length, 1);

  const def = out._aws.CloudWatchMetrics[0];
  assert.equal(def.Namespace, 'Diamondigital/InvoicesAgent');
  assert.ok(Array.isArray(def.Dimensions));

  const names = def.Metrics.map((m) => m.Name);
  assert.deepEqual(names.sort(), ['EmailsProcessed', 'EmailsSkipped', 'UploadsFailed', 'UploadsSuccessful']);
  for (const m of def.Metrics) {
    assert.equal(m.Unit, 'Count');
  }

  assert.equal(out.EmailsProcessed, 3);
  assert.equal(out.UploadsSuccessful, 2);
  assert.equal(out.EmailsSkipped, 1);
  assert.equal(out.UploadsFailed, 0);
});

test('emitMetrics writes exactly one console.log line of valid JSON', () => {
  let lines;
  lines = capture(() => {
    emitMetrics({ processed: 5, successful: 4, skipped: 0, failed: 1 }, 1700000000001);
    return null;
  });
});

test('emitMetrics logs one parseable EMF line', () => {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    emitMetrics({ processed: 5, successful: 4, skipped: 0, failed: 1 }, 42);
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed._aws.Timestamp, 42);
  assert.equal(parsed.UploadsFailed, 1);
});

test('emitMetrics defaults timestamp to Date.now()', () => {
  const before = Date.now();
  let out;
  const original = console.log;
  console.log = () => {};
  try {
    out = emitMetrics({ processed: 0, successful: 0, skipped: 0, failed: 0 });
  } finally {
    console.log = original;
  }
  const after = Date.now();
  assert.ok(out._aws.Timestamp >= before && out._aws.Timestamp <= after);
});
