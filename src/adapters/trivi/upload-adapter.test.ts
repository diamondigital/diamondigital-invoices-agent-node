import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { TriviUploadAdapter } from './upload-adapter.js';
import type { TriviAuth } from './auth.js';
import type { Attachment, TriviConfig } from '../../domain/types.js';

interface AxiosPostResult {
  status?: number;
  data: unknown;
}

interface ScanBodyItem {
  files: string[];
  customerInstructions: string;
  paymentType?: number;
}

const cfg: TriviConfig = {
  appId: 'app',
  appSecret: 'secret',
  baseUrl: 'https://api.trivi.com/v2',
  uploadsPath: '/uploads',
  scansPath: '/accountingdocuments/scans',
  uploadFieldName: 'file',
};
const auth = { getToken: async (): Promise<string> => 'tok' } as unknown as TriviAuth;

function tmpFile(): Attachment {
  const p = path.join(os.tmpdir(), `trivi-${process.hrtime.bigint()}.pdf`);
  fs.writeFileSync(p, '%PDF-1.4');
  return { path: p, filename: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 8 };
}

test('uploadDocumentAttachment runs the two-step upload→scan flow', async () => {
  const urls: string[] = [];
  mock.method(axios, 'post', async (url: string): Promise<AxiosPostResult> => {
    urls.push(url);
    if (url.endsWith('/uploads')) return { data: { id: 42 } };
    return { status: 201, data: [{ accountingDocumentId: 7, files: [42] }] };
  });
  const svc = new TriviUploadAdapter(cfg, auth);
  const res = await svc.uploadDocumentAttachment(tmpFile(), { subject: 'Faktura', classification: { paymentMethod: 'cash' } });
  assert.equal(res.fileId, 42);
  assert.equal(urls.length, 2);
  assert.ok(urls[0]?.endsWith('/uploads'));
  assert.ok(urls[1]?.endsWith('/accountingdocuments/scans'));
  mock.reset();
});

test('uploadDocumentAttachment throws when /uploads returns HTML', async () => {
  mock.method(axios, 'post', async (): Promise<AxiosPostResult> => ({ data: '<!doctype html><html></html>' }));
  const svc = new TriviUploadAdapter(cfg, auth);
  await assert.rejects(() => svc.uploadDocumentAttachment(tmpFile(), {}), /HTML instead of JSON/);
  mock.reset();
});

test('uploadDocumentAttachment throws when no file id is returned', async () => {
  mock.method(axios, 'post', async (): Promise<AxiosPostResult> => ({ data: {} }));
  const svc = new TriviUploadAdapter(cfg, auth);
  await assert.rejects(() => svc.uploadDocumentAttachment(tmpFile(), {}), /did not return a file id/);
  mock.reset();
});

test('uploadDocumentAttachment sets paymentType from classification', async () => {
  let scanBody: ScanBodyItem[] | undefined;
  mock.method(axios, 'post', async (url: string, body?: unknown): Promise<AxiosPostResult> => {
    if (url.endsWith('/uploads')) return { data: { id: 1 } };
    scanBody = body as ScanBodyItem[];
    return { status: 201, data: [{}] };
  });
  const svc = new TriviUploadAdapter(cfg, auth);
  await svc.uploadDocumentAttachment(tmpFile(), { classification: { paymentMethod: 'card' } });
  assert.equal(scanBody?.[0]?.paymentType, 4);
  mock.reset();
});

test('uploadDocumentAttachment omits paymentType for unknown/missing method', async () => {
  let scanBody: ScanBodyItem[] | undefined;
  mock.method(axios, 'post', async (url: string, body?: unknown): Promise<AxiosPostResult> => {
    if (url.endsWith('/uploads')) return { data: { id: 1 } };
    scanBody = body as ScanBodyItem[];
    return { status: 201, data: [{}] };
  });
  const svc = new TriviUploadAdapter(cfg, auth);
  await svc.uploadDocumentAttachment(tmpFile(), { classification: { paymentMethod: 'unknown' } });
  const item = scanBody?.[0];
  assert.ok(item !== undefined && !('paymentType' in item));
  mock.reset();
});

test('step-2 failure retries ONLY step 2, never re-uploading the file (idempotent)', async () => {
  let uploadCalls = 0;
  let scanCalls = 0;
  mock.method(axios, 'post', async (url: string): Promise<AxiosPostResult> => {
    if (url.endsWith('/uploads')) {
      uploadCalls++;
      return { data: { id: 99 } };
    }
    scanCalls++;
    if (scanCalls === 1) {
      const err = new Error('scans 503') as Error & { response?: { status: number } };
      err.response = { status: 503 };
      throw err;
    }
    return { status: 201, data: [{ accountingDocumentId: 5 }] };
  });
  const svc = new TriviUploadAdapter(cfg, auth);
  const res = await svc.uploadDocumentAttachment(tmpFile(), {});
  assert.equal(uploadCalls, 1);
  assert.equal(scanCalls, 2);
  assert.equal(res.fileId, 99);
  mock.reset();
});

test('step-1 failure retries step 1 independently (fresh stream per attempt)', async () => {
  let uploadCalls = 0;
  let scanCalls = 0;
  mock.method(axios, 'post', async (url: string): Promise<AxiosPostResult> => {
    if (url.endsWith('/uploads')) {
      uploadCalls++;
      if (uploadCalls === 1) {
        const err = new Error('uploads 500') as Error & { response?: { status: number } };
        err.response = { status: 500 };
        throw err;
      }
      return { data: { id: 7 } };
    }
    scanCalls++;
    return { status: 201, data: [{}] };
  });
  const svc = new TriviUploadAdapter(cfg, auth);
  const res = await svc.uploadDocumentAttachment(tmpFile(), {});
  assert.equal(uploadCalls, 2);
  assert.equal(scanCalls, 1);
  assert.equal(res.fileId, 7);
  mock.reset();
});

test('non-retryable 4xx on step 1 is not retried', async () => {
  let uploadCalls = 0;
  mock.method(axios, 'post', async (url: string): Promise<AxiosPostResult> => {
    if (url.endsWith('/uploads')) {
      uploadCalls++;
      const err = new Error('bad request 400') as Error & { response?: { status: number } };
      err.response = { status: 400 };
      throw err;
    }
    return { status: 201, data: [{}] };
  });
  const svc = new TriviUploadAdapter(cfg, auth);
  await assert.rejects(() => svc.uploadDocumentAttachment(tmpFile(), {}), /bad request 400/);
  assert.equal(uploadCalls, 1);
  mock.reset();
});
