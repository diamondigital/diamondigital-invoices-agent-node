import test from 'node:test';
import assert from 'node:assert/strict';
import { processInvoices, processEmail } from './process-invoices.js';
import type { AppConfig, EmailMessage } from '../domain/types.js';
import type { Services } from '../ports/services.js';
import type { EmailPort } from '../ports/email-port.js';
import type { TriviPort } from '../ports/trivi-port.js';
import type { ClassifierPort } from '../ports/classifier-port.js';
import type { StoragePort } from '../ports/storage-port.js';
import type { NotificationPort } from '../ports/notification-port.js';

interface Fakes {
  moved: { processed: string[]; skipped: string[] };
  uploaded: string[];
  lifecycle: { connected: number; disconnected: number };
  order: string[];
  svc: Services;
}

function fakes(emails: EmailMessage[]): Fakes {
  const moved = { processed: [] as string[], skipped: [] as string[] };
  const uploaded: string[] = [];
  const lifecycle = { connected: 0, disconnected: 0 };
  const order: string[] = [];

  const cfg = { email: { host: 'h', port: 1 }, mistral: { uploadThreshold: 0.85 } } as unknown as AppConfig;

  const emailPort: EmailPort = {
    connect: async () => { lifecycle.connected++; order.push('connect'); },
    disconnect: async () => { lifecycle.disconnected++; order.push('disconnect'); },
    fetchUnprocessedEmails: async () => { order.push('fetch'); return emails; },
    markAsProcessed: async (id) => { moved.processed.push(id); },
    markAsSkipped: async (id) => { moved.skipped.push(id); },
  };

  const trivi: TriviPort = {
    uploadDocumentAttachment: async (a) => { uploaded.push(a.filename); return { fileId: 1, scan: null }; },
  };

  const classifier: ClassifierPort = {
    classifyAttachment: async () => ({ isAccountingDocument: true, confidence: 0.95, docType: 'invoice', paymentMethod: 'cash', reason: '' }),
  };

  const storage: StoragePort = {
    archiveEmail: async () => { },
  };

  const notification: NotificationPort = {
    sendSummary: async () => { },
    sendAlert: async () => { },
  };

  return {
    moved,
    uploaded,
    lifecycle,
    order,
    svc: { cfg, email: emailPort, trivi, classifier, storage, notification },
  };
}

function email(id: string, filename: string): EmailMessage {
  return {
    emailId: id,
    subject: `s${id}`,
    from: 'x',
    receivedDate: new Date(0),
    bodyText: '',
    attachments: [{ filename, path: '/tmp/x', mimeType: 'application/pdf', sizeBytes: 1 }],
  };
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
  svc.trivi.uploadDocumentAttachment = async (a) => { n++; if (a.filename === 'a.pdf') throw new Error('fail'); return { fileId: 1, scan: null }; };
  const results = await processInvoices(svc);
  assert.equal(results.length, 2);
  assert.equal(moved.processed.includes('2'), true);
  assert.equal(moved.processed.includes('1'), false);
});

test('a non-accounting-document email is marked skipped, not processed', async () => {
  const { svc, moved } = fakes([email('1', 'a.pdf')]);
  svc.classifier!.classifyAttachment = async () => ({ isAccountingDocument: false, confidence: 0.1, docType: 'other', paymentMethod: 'unknown', reason: '' });
  await processInvoices(svc);
  assert.deepEqual(moved.skipped, ['1']);
  assert.deepEqual(moved.processed, []);
});

test('confidence below threshold is not uploaded', async () => {
  const { svc, uploaded, moved } = fakes([email('1', 'a.pdf')]);
  svc.classifier!.classifyAttachment = async () => ({ isAccountingDocument: true, confidence: 0.5, docType: 'invoice', paymentMethod: 'cash', reason: '' });
  await processInvoices(svc);
  assert.deepEqual(uploaded, []);
  assert.deepEqual(moved.skipped, ['1']);
});

test('connect is called before fetch and disconnect runs in finally', async () => {
  const { svc, lifecycle, order } = fakes([email('1', 'a.pdf')]);
  await processInvoices(svc);
  assert.equal(lifecycle.connected, 1);
  assert.equal(lifecycle.disconnected, 1);
  assert.equal(order.indexOf('connect') < order.indexOf('fetch'), true);
  assert.equal(order[order.length - 1], 'disconnect');
});

test('empty INBOX still disconnects and does not send summary', async () => {
  const { svc, lifecycle } = fakes([]);
  let summaries = 0;
  svc.notification.sendSummary = async () => { summaries++; };
  const results = await processInvoices(svc);
  assert.deepEqual(results, []);
  assert.equal(lifecycle.connected, 1);
  assert.equal(lifecycle.disconnected, 1);
  assert.equal(summaries, 0);
});

test('fatal path: connect failure alerts, rethrows, and disconnects', async () => {
  const { svc, lifecycle } = fakes([email('1', 'a.pdf')]);
  const alerts: string[] = [];
  svc.email.connect = async () => { lifecycle.connected++; throw new Error('boom'); };
  svc.notification.sendAlert = async (subj) => { alerts.push(subj); };
  await assert.rejects(() => processInvoices(svc), /boom/);
  assert.deepEqual(alerts, ['IMAP connection failed']);
  assert.equal(lifecycle.disconnected, 1);
});

test('fatal path: fetch failure alerts, rethrows, and disconnects', async () => {
  const { svc, lifecycle } = fakes([email('1', 'a.pdf')]);
  const alerts: string[] = [];
  svc.email.fetchUnprocessedEmails = async () => { throw new Error('fetchfail'); };
  svc.notification.sendAlert = async (subj) => { alerts.push(subj); };
  await assert.rejects(() => processInvoices(svc), /fetchfail/);
  assert.deepEqual(alerts, ['IMAP connection failed']);
  assert.equal(lifecycle.connected, 1);
  assert.equal(lifecycle.disconnected, 1);
});

test('processEmail success: uploaded, archived, and marked processed', async () => {
  const { svc, moved, uploaded } = fakes([]);
  const archived: string[] = [];
  svc.storage.archiveEmail = async (id) => { archived.push(id); };
  const result = await processEmail(email('1', 'a.pdf'), svc);
  assert.equal(result.success, true);
  assert.equal(result.uploadedCount, 1);
  assert.deepEqual(result.uploadedNames, ['a.pdf']);
  assert.deepEqual(uploaded, ['a.pdf']);
  assert.deepEqual(archived, ['1']);
  assert.deepEqual(moved.processed, ['1']);
  assert.deepEqual(moved.skipped, []);
});

test('processEmail non-accounting-document: marked skipped, not processed', async () => {
  const { svc, moved } = fakes([]);
  svc.classifier!.classifyAttachment = async () => ({ isAccountingDocument: false, confidence: 0.1, docType: 'other', paymentMethod: 'unknown', reason: '' });
  const result = await processEmail(email('1', 'a.pdf'), svc);
  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.deepEqual(moved.skipped, ['1']);
  assert.deepEqual(moved.processed, []);
});

test('processEmail upload throws: result.error set, email not moved', async () => {
  const { svc, moved } = fakes([]);
  svc.trivi.uploadDocumentAttachment = async () => { throw new Error('uploadfail'); };
  const result = await processEmail(email('1', 'a.pdf'), svc);
  assert.equal(result.success, false);
  assert.equal(result.error, 'uploadfail');
  assert.equal(result.skipped, undefined);
  assert.deepEqual(moved.processed, []);
  assert.deepEqual(moved.skipped, []);
});
