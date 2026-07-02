import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chat } from '@mistralai/mistralai/sdk/chat.js';
import { Ocr } from '@mistralai/mistralai/sdk/ocr.js';
import { DEFAULT_CLASSIFIER_MODEL, MistralClassifierAdapter, OCR_MODEL } from './classifier-adapter.js';
import type { Attachment } from '../../domain/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', 'shared', 'fixtures');

interface CapturedChatContentPart {
  type: string;
  text?: string;
  imageUrl?: string;
}

interface CapturedChatRequest {
  model: string;
  temperature: number;
  responseFormat: { type: string };
  messages: Array<{ role: string; content: string | CapturedChatContentPart[] }>;
}

interface CapturedOcrRequest {
  model: string;
  document: { type: string; documentUrl?: string; documentName?: string; imageUrl?: string };
}

interface FakeChatChoicesResponse {
  choices: Array<{ message: { content: string } }>;
}

interface FakeOcrPagesResponse {
  pages: Array<{ markdown: string }>;
}

function fakeChatResponse(payload: Record<string, unknown>): FakeChatChoicesResponse {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

function fakeOcrResponse(markdownPages: string[]): FakeOcrPagesResponse {
  return { pages: markdownPages.map((markdown) => ({ markdown })) };
}

function makeAdapter(classifierModel = 'test-model'): MistralClassifierAdapter {
  return new MistralClassifierAdapter({ apiKey: 'test-key', classifierModel });
}

async function writeTempFile(name: string, data: Buffer): Promise<string> {
  const filePath = path.join(os.tmpdir(), `mistral-adapter-${process.hrtime.bigint()}-${name}`);
  await fs.writeFile(filePath, data);
  return filePath;
}

function makeAttachment(overrides: Partial<Attachment> & Pick<Attachment, 'filename' | 'path' | 'mimeType'>): Attachment {
  return { sizeBytes: 0, ...overrides };
}

test('routes vision mime types (png) directly to chat, skipping OCR entirely', async () => {
  const ocrMock = mock.method(Ocr.prototype, 'process', async (): Promise<FakeOcrPagesResponse> => {
    throw new Error('OCR must not be called for vision mime types');
  });
  let captured: CapturedChatRequest | undefined;
  const chatMock = mock.method(Chat.prototype, 'complete', async (request: CapturedChatRequest) => {
    captured = request;
    return fakeChatResponse({ isAccountingDocument: true, confidence: 0.8, docType: 'receipt', paymentMethod: 'cash', reason: 'ok' });
  });

  const pngBuffer = await fs.readFile(path.join(fixturesDir, 'sample.png'));
  const filePath = await writeTempFile('img.png', pngBuffer);
  const adapter = makeAdapter();
  const result = await adapter.classifyAttachment(
    makeAttachment({ filename: 'img.png', path: filePath, mimeType: 'image/png', sizeBytes: pngBuffer.length }),
    { subject: 'Faktura', from: 'a@b.cz' }
  );

  assert.equal(ocrMock.mock.callCount(), 0);
  assert.equal(chatMock.mock.callCount(), 1);
  assert.ok(captured);
  assert.equal(captured.model, 'test-model');
  assert.equal(captured.temperature, 0);
  assert.deepEqual(captured.responseFormat, { type: 'json_object' });
  assert.ok(Array.isArray(captured.messages[0]?.content));
  const content = captured.messages[0]?.content as CapturedChatContentPart[];
  assert.equal(content[0]?.type, 'text');
  assert.match(content[0]?.text ?? '', /img\.png/);
  assert.match(content[0]?.text ?? '', /Faktura/);
  assert.match(content[0]?.text ?? '', /a@b\.cz/);
  assert.equal(content[1]?.type, 'image_url');
  assert.equal(content[1]?.imageUrl, `data:image/png;base64,${pngBuffer.toString('base64')}`);
  assert.equal(result.isAccountingDocument, true);
  assert.equal(result.docType, 'receipt');

  mock.restoreAll();
});

test('routes non-vision mime types through OCR first, then chat with the extracted text', async () => {
  let ocrRequest: CapturedOcrRequest | undefined;
  const ocrMock = mock.method(Ocr.prototype, 'process', async (request: CapturedOcrRequest) => {
    ocrRequest = request;
    return fakeOcrResponse(['Faktura c. 123', 'Celkem 500 Kc']);
  });
  let captured: CapturedChatRequest | undefined;
  const chatMock = mock.method(Chat.prototype, 'complete', async (request: CapturedChatRequest) => {
    captured = request;
    return fakeChatResponse({ isAccountingDocument: true, confidence: 0.5, docType: 'invoice', paymentMethod: 'unknown', reason: 'ok' });
  });

  const pdfBuffer = Buffer.from('%PDF-1.4 test');
  const filePath = await writeTempFile('doc.pdf', pdfBuffer);
  const adapter = makeAdapter('');
  await adapter.classifyAttachment(makeAttachment({ filename: 'doc.pdf', path: filePath, mimeType: 'application/pdf', sizeBytes: pdfBuffer.length }));

  assert.equal(ocrMock.mock.callCount(), 1);
  assert.ok(ocrRequest);
  assert.equal(ocrRequest.model, OCR_MODEL);
  assert.equal(ocrRequest.document.type, 'document_url');
  assert.equal(ocrRequest.document.documentName, 'doc.pdf');
  assert.equal(ocrRequest.document.documentUrl, `data:application/pdf;base64,${pdfBuffer.toString('base64')}`);

  assert.equal(chatMock.mock.callCount(), 1);
  assert.ok(captured);
  assert.equal(captured.model, DEFAULT_CLASSIFIER_MODEL);
  assert.equal(typeof captured.messages[0]?.content, 'string');
  const text = captured.messages[0]?.content as string;
  assert.match(text, /Faktura c\. 123/);
  assert.match(text, /Celkem 500 Kc/);
  assert.match(text, /\(neznámý\)/);

  mock.restoreAll();
});

test('OCR routes non-PDF, non-vision types (e.g. TIFF) as image_url documents', async () => {
  let ocrRequest: CapturedOcrRequest | undefined;
  mock.method(Ocr.prototype, 'process', async (request: CapturedOcrRequest) => {
    ocrRequest = request;
    return fakeOcrResponse([]);
  });
  mock.method(Chat.prototype, 'complete', async () =>
    fakeChatResponse({ isAccountingDocument: false, confidence: 0, docType: 'other', paymentMethod: 'unknown', reason: '' })
  );

  const tiffBuffer = Buffer.from('fake-tiff-bytes');
  const filePath = await writeTempFile('scan.tiff', tiffBuffer);
  const adapter = makeAdapter();
  await adapter.classifyAttachment(makeAttachment({ filename: 'scan.tiff', path: filePath, mimeType: 'image/tiff', sizeBytes: tiffBuffer.length }));

  assert.ok(ocrRequest);
  assert.equal(ocrRequest.document.type, 'image_url');
  assert.equal(ocrRequest.document.imageUrl, `data:image/tiff;base64,${tiffBuffer.toString('base64')}`);

  mock.restoreAll();
});

test('truncates OCR text to 6000 characters before sending to chat', async () => {
  const longText = 'x'.repeat(7000);
  mock.method(Ocr.prototype, 'process', async () => fakeOcrResponse([longText]));
  let captured: CapturedChatRequest | undefined;
  mock.method(Chat.prototype, 'complete', async (request: CapturedChatRequest) => {
    captured = request;
    return fakeChatResponse({ isAccountingDocument: false, confidence: 0, docType: 'other', paymentMethod: 'unknown', reason: '' });
  });

  const filePath = await writeTempFile('doc.pdf', Buffer.from('x'));
  const adapter = makeAdapter();
  await adapter.classifyAttachment(makeAttachment({ filename: 'doc.pdf', path: filePath, mimeType: 'application/pdf' }));

  assert.ok(captured);
  const text = captured.messages[0]?.content as string;
  const ocrSection = text.split('--- OBSAH (z OCR) ---\n')[1]?.split('\n--- KONEC ---')[0];
  assert.equal(ocrSection?.length, 6000);

  mock.restoreAll();
});

test('converts HEIC attachments to JPEG and routes through vision, never calling OCR', async () => {
  const heicBuffer = await fs.readFile(path.join(fixturesDir, 'sample.heic'));
  const filePath = await writeTempFile('photo.heic', heicBuffer);

  const ocrMock = mock.method(Ocr.prototype, 'process', async (): Promise<FakeOcrPagesResponse> => {
    throw new Error('OCR must not be called for HEIC attachments');
  });
  let captured: CapturedChatRequest | undefined;
  const chatMock = mock.method(Chat.prototype, 'complete', async (request: CapturedChatRequest) => {
    captured = request;
    return fakeChatResponse({ isAccountingDocument: false, confidence: 0.1, docType: 'other', paymentMethod: 'unknown', reason: 'not a doc' });
  });

  const adapter = makeAdapter();
  await adapter.classifyAttachment(makeAttachment({ filename: 'photo.heic', path: filePath, mimeType: 'image/heic', sizeBytes: heicBuffer.length }));

  assert.equal(ocrMock.mock.callCount(), 0);
  assert.equal(chatMock.mock.callCount(), 1);
  assert.ok(captured);
  const content = captured.messages[0]?.content as CapturedChatContentPart[];
  assert.ok(content[1]?.imageUrl?.startsWith('data:image/jpeg;base64,'));

  mock.restoreAll();
});

test('falls back to a safe default classification when the chat response has no choices', async () => {
  mock.method(Ocr.prototype, 'process', async () => fakeOcrResponse(['text']));
  mock.method(Chat.prototype, 'complete', async () => ({ choices: [] }) as FakeChatChoicesResponse);

  const filePath = await writeTempFile('doc.pdf', Buffer.from('x'));
  const adapter = makeAdapter();
  const result = await adapter.classifyAttachment(makeAttachment({ filename: 'doc.pdf', path: filePath, mimeType: 'application/pdf' }));

  assert.equal(result.isAccountingDocument, false);
  assert.equal(result.confidence, 0);
  assert.equal(result.reason, 'classification_unavailable');

  mock.restoreAll();
});

test('uses the default context placeholders when subject/from are omitted', async () => {
  let captured: CapturedChatRequest | undefined;
  mock.method(Ocr.prototype, 'process', async () => fakeOcrResponse(['content']));
  mock.method(Chat.prototype, 'complete', async (request: CapturedChatRequest) => {
    captured = request;
    return fakeChatResponse({ isAccountingDocument: false, confidence: 0, docType: 'other', paymentMethod: 'unknown', reason: '' });
  });

  const filePath = await writeTempFile('doc.pdf', Buffer.from('x'));
  const adapter = makeAdapter();
  await adapter.classifyAttachment(makeAttachment({ filename: 'doc.pdf', path: filePath, mimeType: 'application/pdf' }));

  assert.ok(captured);
  const text = captured.messages[0]?.content as string;
  const occurrences = text.match(/\(neznámý\)/g) ?? [];
  assert.equal(occurrences.length, 2);

  mock.restoreAll();
});

test('falls back to DEFAULT_CLASSIFIER_MODEL when no classifierModel is configured', async () => {
  let captured: CapturedChatRequest | undefined;
  mock.method(Ocr.prototype, 'process', async () => fakeOcrResponse(['content']));
  mock.method(Chat.prototype, 'complete', async (request: CapturedChatRequest) => {
    captured = request;
    return fakeChatResponse({ isAccountingDocument: false, confidence: 0, docType: 'other', paymentMethod: 'unknown', reason: '' });
  });

  const filePath = await writeTempFile('doc.pdf', Buffer.from('x'));
  const adapter = new MistralClassifierAdapter({ apiKey: 'test-key', classifierModel: '' });
  await adapter.classifyAttachment(makeAttachment({ filename: 'doc.pdf', path: filePath, mimeType: 'application/pdf' }));

  assert.ok(captured);
  assert.equal(captured.model, DEFAULT_CLASSIFIER_MODEL);

  mock.restoreAll();
});
