import test from 'node:test';
import assert from 'node:assert/strict';
import { isInvoiceAttachment } from './attachment-filter.js';

test('accepts by extension', () => {
  assert.equal(isInvoiceAttachment({ filename: 'a.pdf', mimeType: '' }), true);
  assert.equal(isInvoiceAttachment({ filename: 'a.PNG', mimeType: '' }), true);
});
test('accepts by MIME when extension is unknown', () => {
  assert.equal(isInvoiceAttachment({ filename: 'noext', mimeType: 'application/pdf' }), true);
});
test('rejects non-invoice types', () => {
  assert.equal(isInvoiceAttachment({ filename: 'a.txt', mimeType: 'text/plain' }), false);
});
