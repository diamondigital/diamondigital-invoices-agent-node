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
