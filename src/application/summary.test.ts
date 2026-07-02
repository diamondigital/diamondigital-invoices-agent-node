import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryLines } from './summary.js';

test('buildSummaryLines tallies ok / skip / fail', () => {
  const lines = buildSummaryLines([
    { emailId: '1', subject: 'A', success: true, uploadedCount: 1, classifications: [{ filename: 'a.pdf', isAccountingDocument: true, uploaded: true, docType: 'invoice', confidence: 0.9, reason: '' }] },
    { emailId: '2', subject: 'B', success: false, skipped: true, skipReason: 'no invoice-like attachment', classifications: [] },
    { emailId: '3', subject: 'C', success: false, error: 'boom' },
  ]).join('\n');
  assert.match(lines, /Celkem e-mailů: 3/);
  assert.match(lines, /Úspěšně nahráno: 1/);
  assert.match(lines, /Chyby: 1/);
  assert.match(lines, /Přeskočeno.*: 1/);
  assert.match(lines, /boom/);
});
