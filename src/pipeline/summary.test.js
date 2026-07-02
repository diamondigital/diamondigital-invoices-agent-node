import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryLines } from './summary.js';

test('buildSummaryLines tallies ok / skip / fail', () => {
  const lines = buildSummaryLines([
    { success: true, uploadedCount: 1, subject: 'A', classifications: [{ uploaded: true, docType: 'invoice', confidence: 0.9 }] },
    { success: false, skipped: true, subject: 'B', skipReason: 'no invoice-like attachment', classifications: [] },
    { success: false, subject: 'C', error: 'boom' },
  ]).join('\n');
  assert.match(lines, /Celkem e-mailů: 3/);
  assert.match(lines, /Úspěšně nahráno: 1/);
  assert.match(lines, /Chyby: 1/);
  assert.match(lines, /Přeskočeno.*: 1/);
  assert.match(lines, /boom/);
});
