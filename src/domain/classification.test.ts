import test from 'node:test';
import assert from 'node:assert/strict';
import { guessMimeType, parseClassification } from './classification.js';

test('guessMimeType maps by extension', () => {
  assert.equal(guessMimeType('a.pdf'), 'application/pdf');
  assert.equal(guessMimeType('a.PNG'), 'image/png');
  assert.equal(guessMimeType('a.jpeg'), 'image/jpeg');
  assert.equal(guessMimeType('a.heic'), 'image/heic');
  assert.equal(guessMimeType('a.unknown', 'application/octet-stream'), 'application/octet-stream');
});

test('parseClassification returns the parsed object for valid JSON', () => {
  const r = parseClassification('{"isAccountingDocument":true,"confidence":0.9,"docType":"invoice","paymentMethod":"cash","reason":"x"}');
  assert.equal(r.isAccountingDocument, true);
  assert.equal(r.confidence, 0.9);
  assert.equal(r.docType, 'invoice');
});

test('parseClassification clamps confidence and falls back on garbage', () => {
  assert.equal(parseClassification('{"confidence":5}').confidence, 1);
  const bad = parseClassification('not json');
  assert.equal(bad.isAccountingDocument, false);
  assert.equal(bad.confidence, 0);
  assert.equal(bad.reason, 'classification_unavailable');
});
