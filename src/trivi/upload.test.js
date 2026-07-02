import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { TriviService } from './upload.js';

const cfg = { baseUrl: 'https://api.trivi.com/v2', uploadsPath: '/uploads', scansPath: '/accountingdocuments/scans', uploadFieldName: 'file' };
const auth = { getToken: async () => 'tok' };

function tmpFile() {
  const p = path.join(os.tmpdir(), `trivi-${process.hrtime.bigint()}.pdf`);
  fs.writeFileSync(p, '%PDF-1.4');
  return { path: p, filename: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 8 };
}

test('uploadDocumentAttachment runs the two-step upload→scan flow', async () => {
  const urls = [];
  mock.method(axios, 'post', async (url) => {
    urls.push(url);
    if (url.endsWith('/uploads')) return { data: { id: 42 } };
    return { status: 201, data: [{ accountingDocumentId: 7, files: [42] }] };
  });
  const svc = new TriviService(cfg, auth);
  const res = await svc.uploadDocumentAttachment(tmpFile(), { subject: 'Faktura', classification: { paymentMethod: 'cash' } });
  assert.equal(res.fileId, 42);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].endsWith('/uploads'));
  assert.ok(urls[1].endsWith('/accountingdocuments/scans'));
  mock.reset();
});

test('uploadDocumentAttachment throws when /uploads returns HTML', async () => {
  mock.method(axios, 'post', async () => ({ data: '<!doctype html><html></html>' }));
  const svc = new TriviService(cfg, auth);
  await assert.rejects(() => svc.uploadDocumentAttachment(tmpFile(), {}), /HTML instead of JSON/);
  mock.reset();
});

test('uploadDocumentAttachment throws when no file id is returned', async () => {
  mock.method(axios, 'post', async () => ({ data: {} }));
  const svc = new TriviService(cfg, auth);
  await assert.rejects(() => svc.uploadDocumentAttachment(tmpFile(), {}), /did not return a file id/);
  mock.reset();
});

test('uploadDocumentAttachment sets paymentType from classification', async () => {
  let scanBody;
  mock.method(axios, 'post', async (url, body) => {
    if (url.endsWith('/uploads')) return { data: { id: 1 } };
    scanBody = body;
    return { status: 201, data: [{}] };
  });
  const svc = new TriviService(cfg, auth);
  await svc.uploadDocumentAttachment(tmpFile(), { classification: { paymentMethod: 'card' } });
  assert.equal(scanBody[0].paymentType, 4);
  mock.reset();
});

test('uploadDocumentAttachment omits paymentType for unknown/missing method', async () => {
  let scanBody;
  mock.method(axios, 'post', async (url, body) => {
    if (url.endsWith('/uploads')) return { data: { id: 1 } };
    scanBody = body;
    return { status: 201, data: [{}] };
  });
  const svc = new TriviService(cfg, auth);
  await svc.uploadDocumentAttachment(tmpFile(), { classification: { paymentMethod: 'bitcoin' } });
  assert.ok(!('paymentType' in scanBody[0]));
  mock.reset();
});

test('step-2 failure retries ONLY step 2, never re-uploading the file (idempotent)', async () => {
  let uploadCalls = 0;
  let scanCalls = 0;
  mock.method(axios, 'post', async (url) => {
    if (url.endsWith('/uploads')) {
      uploadCalls++;
      return { data: { id: 99 } };
    }
    scanCalls++;
    if (scanCalls === 1) {
      const err = new Error('scans 503');
      err.response = { status: 503 };
      throw err;
    }
    return { status: 201, data: [{ accountingDocumentId: 5 }] };
  });
  const svc = new TriviService(cfg, auth);
  const res = await svc.uploadDocumentAttachment(tmpFile(), {});
  assert.equal(uploadCalls, 1);
  assert.equal(scanCalls, 2);
  assert.equal(res.fileId, 99);
  mock.reset();
});

test('step-1 failure retries step 1 independently (fresh stream per attempt)', async () => {
  let uploadCalls = 0;
  let scanCalls = 0;
  mock.method(axios, 'post', async (url) => {
    if (url.endsWith('/uploads')) {
      uploadCalls++;
      if (uploadCalls === 1) {
        const err = new Error('uploads 500');
        err.response = { status: 500 };
        throw err;
      }
      return { data: { id: 7 } };
    }
    scanCalls++;
    return { status: 201, data: [{}] };
  });
  const svc = new TriviService(cfg, auth);
  const res = await svc.uploadDocumentAttachment(tmpFile(), {});
  assert.equal(uploadCalls, 2);
  assert.equal(scanCalls, 1);
  assert.equal(res.fileId, 7);
  mock.reset();
});

test('non-retryable 4xx on step 1 is not retried', async () => {
  let uploadCalls = 0;
  mock.method(axios, 'post', async (url) => {
    if (url.endsWith('/uploads')) {
      uploadCalls++;
      const err = new Error('bad request 400');
      err.response = { status: 400 };
      throw err;
    }
    return { status: 201, data: [{}] };
  });
  const svc = new TriviService(cfg, auth);
  await assert.rejects(() => svc.uploadDocumentAttachment(tmpFile(), {}), /bad request 400/);
  assert.equal(uploadCalls, 1);
  mock.reset();
});
