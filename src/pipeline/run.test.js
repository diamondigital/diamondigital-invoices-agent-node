import test from 'node:test';
import assert from 'node:assert/strict';
import { processInvoices } from './run.js';

function fakes(emails) {
  const moved = { processed: [], skipped: [] };
  const uploaded = [];
  return {
    moved, uploaded,
    svc: {
      cfg: { email: { host: 'h', port: 1 }, mistral: { uploadThreshold: 0.85 } },
      email: {
        fetchUnprocessedEmails: async () => emails,
        markAsProcessed: async (id) => { moved.processed.push(id); },
        markAsSkipped: async (id) => { moved.skipped.push(id); },
      },
      trivi: { uploadDocumentAttachment: async (a) => { uploaded.push(a.filename); return { fileId: 1 }; } },
      classifier: { classifyAttachment: async () => ({ isAccountingDocument: true, confidence: 0.95, docType: 'invoice', paymentMethod: 'cash', reason: '' }) },
      storage: { archiveEmail: async () => {} },
      notification: { sendSummary: async () => {}, sendAlert: async () => {} },
    },
  };
}

function email(id, filename) {
  return { emailId: id, subject: `s${id}`, from: 'x', receivedDate: new Date(0), attachments: [{ filename, path: '/tmp/x', mimeType: 'application/pdf', sizeBytes: 1 }] };
}

test('marks processed only after a successful upload', async () => {
  const { svc, moved, uploaded } = fakes([email('1', 'a.pdf')]);
  await processInvoices(svc);
  assert.deepEqual(uploaded, ['a.pdf']);
  assert.deepEqual(moved.processed, ['1']);
});

test('one email failing does not abort the others', async () => {
  const { svc, moved } = fakes([email('1', 'a.pdf'), email('2', 'b.pdf')]);
  let n = 0;
  svc.trivi.uploadDocumentAttachment = async (a) => { n++; if (a.filename === 'a.pdf') throw new Error('fail'); return { fileId: 1 }; };
  const results = await processInvoices(svc);
  assert.equal(results.length, 2);
  assert.equal(moved.processed.includes('2'), true);
  assert.equal(moved.processed.includes('1'), false);
});

test('a non-accounting-document email is marked skipped, not processed', async () => {
  const { svc, moved } = fakes([email('1', 'a.pdf')]);
  svc.classifier.classifyAttachment = async () => ({ isAccountingDocument: false, confidence: 0.1, docType: 'other', paymentMethod: 'unknown', reason: '' });
  await processInvoices(svc);
  assert.deepEqual(moved.skipped, ['1']);
  assert.deepEqual(moved.processed, []);
});

test('confidence below threshold is not uploaded', async () => {
  const { svc, uploaded, moved } = fakes([email('1', 'a.pdf')]);
  svc.classifier.classifyAttachment = async () => ({ isAccountingDocument: true, confidence: 0.5, docType: 'invoice', paymentMethod: 'cash', reason: '' });
  await processInvoices(svc);
  assert.deepEqual(uploaded, []);
  assert.deepEqual(moved.skipped, ['1']);
});
