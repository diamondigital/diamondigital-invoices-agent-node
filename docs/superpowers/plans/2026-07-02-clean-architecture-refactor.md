# Clean-Architecture Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slim the codebase to comment-free, self-explanatory, domain-organized modules with essential paths tested — without changing the upload pipeline's behavior.

**Architecture:** Delete dead invoice-creation code, then move each concern into a domain folder (`pipeline/`, `email/`, `trivi/`, `classify/`, `aws/`, `lib/`) with `handler.js` as a thin Lambda entry. Strip every comment as each file moves; migrate the "why" into AGENTS.md. Add `node:test` coverage for the two-step TRIVI upload, retry, config, and the orchestration decision logic.

**Tech Stack:** Node.js 22 (ESM), `node:test`, axios, form-data, imapflow, mailparser, sharp, heic-convert, AWS SDK v3.

## Global Constraints

- ESM only (`"type": "module"`); `import`, never `require`.
- Deploy is a container-image Lambda (`public.ecr.aws/lambda/nodejs:22`, `npm ci --production`); `sharp` stays in `dependencies`.
- **No behavior change** to the email→TRIVI upload flow. The 6 invariants in the spec hold.
- **Zero comments** in `src/`: no `//`, `/* */`, JSDoc, or file-header comments. Logs are NOT comments — keep them with their `[area]` prefix (`[email]`, `[trivi]`, `[trivi-auth]`, `[retry]`, `[lambda]`, `[storage]`, `[notification]`, `[classify]`, `[processing]`, `[ok]`, `[skip]`, `[warn]`, `[error]`, `[fatal]`).
- User-facing text (summary, alerts) stays Czech; logs stay English.
- Run tests with `npm test`. After Task 8 this is `node --test` (auto-discovers nested `*.test.js`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Keep the full suite green after every task.

---

## Target file structure (end state)

```
src/
  handler.js              Lambda entry: setup() + handler
  config.js               config loading
  pipeline/
    run.js                processInvoices(svc) orchestration
    attachment-filter.js  isInvoiceAttachment
    summary.js            buildSummaryLines + sendSummary
  email/
    client.js             EmailService (IMAP fetch + move)
    materialize.js        materializeAttachments, extractZipEntries, isZipAttachment, writeAttachmentRecord, normalizeDocumentContent, inferMime, uniqueName
  trivi/
    auth.js               TriviAuth
    upload.js             TriviService (uploadDocumentAttachment only)
  classify/
    classifier.js         DocumentClassifier
  aws/
    storage.js            StorageService
    notifications.js      NotificationService
  lib/
    image.js              needsPngConversion, toPng, toPngFilename
    retry.js              withRetry
```

Tests live beside their module (`lib/retry.test.js`, `trivi/upload.test.js`, etc.). Fixtures move to `email/fixtures/` (see Task 6).

---

## Phase 0 — Prune dead code

### Task 1: Delete dead invoice-creation code

**Files:**
- Delete: `src/finaccount-mapper.js`
- Modify: `src/trivi-service.js` (remove everything except the upload flow)
- Modify: `src/config.js`, `.env`, `.env.example`, `terraform/secrets.tf` (drop `bankAccountId` / `TRIVI_BANK_ACCOUNT_ID`)

**Interfaces:**
- Produces: `TriviService` with only `constructor(config, auth)`, `#authHeaders()`, `uploadDocumentAttachment(attachment, metadata)`.

- [ ] **Step 1: Confirm the dead code has no importers**

Run:
```bash
grep -rn "finaccount-mapper" src/ ; echo "---"
grep -rn "\.\(createInvoice\|getDocument\|getDocumentIssues\|getOrCreateContact\|findContactBy\|createContact\|getSequences\|getVatRates\|getBankAccounts\)(" src/ | grep -v trivi-service.js
```
Expected: only the header line of `finaccount-mapper.js` (if any) and no pipeline call sites.

- [ ] **Step 2: Delete `finaccount-mapper.js`**

Run:
```bash
git rm src/finaccount-mapper.js
```

- [ ] **Step 3: Slim `src/trivi-service.js`**

Keep the file header comment for now (removed in Task 4). Keep ONLY: the imports (`axios`, `FormData`, `fs`), the class, the constructor, `#authHeaders()`, and `uploadDocumentAttachment()`. Delete the `#headers()` method, `this.bankAccountId` in the constructor, and every other method (`createInvoice`, `getDocument`, `getDocumentIssues`, `findContactByExternalId`, `findContactByEmail`, `createContact`, `getOrCreateContact`, `getSequences`, `getVatRates`, `getBankAccounts`) and the `// ─── Contacts ───`/`// ─── Lookups ───`/`// ─── Accounting Documents ───` section banners.

- [ ] **Step 4: Drop `bankAccountId` plumbing**

- In `src/config.js`, delete the `bankAccountId: parseInt(process.env.TRIVI_BANK_ACCOUNT_ID || '0', 10),` line from the `trivi` block and the `bankAccountId` mention in the `loadConfig` JSDoc `@returns`.
- In `.env` and `.env.example`, delete the `TRIVI_BANK_ACCOUNT_ID` line and its "Optional legacy invoice-creation settings" comment.
- In `terraform/secrets.tf`, remove `"bankAccountId":0` from the example JSON.

- [ ] **Step 5: Run the full suite**

Run:
```bash
npm test
```
Expected: 27 tests pass (unchanged — no test referenced the deleted code).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete dead invoice-creation code (finaccount-mapper, unused TRIVI methods)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1 — Restructure into domain folders, strip comments, add tests

> For every move task: use `git mv` to preserve history, then delete ALL comments from the moved file (`//`, `/* */`, JSDoc, header), then fix import paths in the file and in every importer. Keep exported class/function names identical unless the task says otherwise.

### Task 2: `lib/` — retry + image

**Files:**
- Move: `src/retry.js` → `src/lib/retry.js`; `src/image-conversion.js` → `src/lib/image.js`
- Move: `src/image-conversion.test.js` → `src/lib/image.test.js`
- Create: `src/lib/retry.test.js`
- Modify importers: `src/index.js` (`./retry.js` → `./lib/retry.js`), `src/email-service.js` (`./image-conversion.js` → `./lib/image.js`)

**Interfaces:**
- Produces: `withRetry(fn, opts)` from `lib/retry.js`; `needsPngConversion`, `toPng`, `toPngFilename` from `lib/image.js`.

- [ ] **Step 1: Write `src/lib/retry.test.js`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './retry.js';

test('withRetry returns the result on first success', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; return 'ok'; }, { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(await fn(), 'ok');
  assert.equal(calls, 1);
});

test('withRetry recovers after transient failures', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; if (calls < 3) throw new Error('boom'); return 'ok'; },
    { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(await fn(), 'ok');
  assert.equal(calls, 3);
});

test('withRetry throws after exhausting attempts', async () => {
  let calls = 0;
  const fn = withRetry(async () => { calls++; throw new Error('always'); }, { maxAttempts: 3, baseDelayMs: 1 });
  await assert.rejects(() => fn(), /always/);
  assert.equal(calls, 3);
});
```

- [ ] **Step 2: Verify it fails**

Run: `mkdir -p src/lib && node --test src/lib/retry.test.js`
Expected: FAIL — cannot find `./retry.js`.

- [ ] **Step 3: Move and strip the two modules**

```bash
git mv src/retry.js src/lib/retry.js
git mv src/image-conversion.js src/lib/image.js
git mv src/image-conversion.test.js src/lib/image.test.js
git mv src/fixtures src/lib/fixtures
```
Then delete every comment from `src/lib/retry.js` and `src/lib/image.js`. In `src/lib/image.test.js`, the import `./image-conversion.js` becomes `./image.js`. The fixture read stays `path.join(here, 'fixtures', 'sample.heic')` — it now resolves to `src/lib/fixtures/sample.heic` because both the test and the fixtures moved into `src/lib/`. The `email` materialize tests do NOT use these fixtures (they generate buffers with `sharp`/`AdmZip`), so `src/lib/fixtures/` is the fixtures' permanent home.

- [ ] **Step 4: Fix importers**

- `src/index.js`: `import { withRetry } from './retry.js';` → `'./lib/retry.js'`.
- `src/email-service.js`: `import { needsPngConversion, toPng, toPngFilename } from './image-conversion.js';` → `'./lib/image.js'`.

- [ ] **Step 5: Run tests**

Run: `node --test src/lib/retry.test.js src/lib/image.test.js && npm test`
Expected: retry (3) + image (7) pass; full suite still 27.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move retry + image conversion into src/lib, add retry tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3: `aws/` — storage + notifications

**Files:**
- Move: `src/storage-service.js` → `src/aws/storage.js`; `src/notification-service.js` → `src/aws/notifications.js`
- Modify importer: `src/index.js`

**Interfaces:**
- Produces: `StorageService` (`archiveEmail(emailId, content)`) from `aws/storage.js`; `NotificationService` (`sendSummary(message)`, `sendAlert(subject, body)`) from `aws/notifications.js`.

- [ ] **Step 1: Move and strip**

```bash
mkdir -p src/aws
git mv src/storage-service.js src/aws/storage.js
git mv src/notification-service.js src/aws/notifications.js
```
Delete every comment from both files.

- [ ] **Step 2: Fix importer**

In `src/index.js`:
```
import { StorageService } from './storage-service.js';   → './aws/storage.js'
import { NotificationService } from './notification-service.js';   → './aws/notifications.js'
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: 30 tests pass (27 + 3 from Task 2).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move storage + notifications into src/aws

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4: `trivi/` — auth + upload, with upload tests

**Files:**
- Move: `src/trivi-auth.js` → `src/trivi/auth.js`; `src/trivi-service.js` → `src/trivi/upload.js`
- Create: `src/trivi/upload.test.js`
- Modify importer: `src/index.js`

**Interfaces:**
- Consumes: `TriviAuth` from `trivi/auth.js` (`getToken(): Promise<string>`).
- Produces: `TriviService` from `trivi/upload.js`: `uploadDocumentAttachment(attachment, metadata) -> Promise<{fileId, scan}>`, where `attachment` is `{path, filename, mimeType, sizeBytes}` and `metadata.classification.paymentMethod` maps via `{bank_transfer:1, cash:2, cod:3, card:4}`.

- [ ] **Step 1: Write `src/trivi/upload.test.js`**

```javascript
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
```

- [ ] **Step 2: Verify it fails**

Run: `mkdir -p src/trivi && node --test src/trivi/upload.test.js`
Expected: FAIL — cannot find `./upload.js`.

- [ ] **Step 3: Move and strip**

```bash
git mv src/trivi-auth.js src/trivi/auth.js
git mv src/trivi-service.js src/trivi/upload.js
```
Delete every comment from both files. In `upload.js`, keep the `PAYMENT_TYPE_CODES` constant (it replaces the enum comment); no other comments remain.

- [ ] **Step 4: Fix importer**

In `src/index.js`:
```
import { TriviAuth } from './trivi-auth.js';   → './trivi/auth.js'
import { TriviService } from './trivi-service.js';   → './trivi/upload.js'
```

- [ ] **Step 5: Run tests**

Run: `node --test src/trivi/upload.test.js && npm test`
Expected: upload (4) pass; full suite 34.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move TRIVI auth + upload into src/trivi, add upload tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: `classify/` — classifier + pure-bit tests

**Files:**
- Move: `src/document-classifier.js` → `src/classify/classifier.js`
- Create: `src/classify/classifier.test.js`
- Modify importer: `src/index.js`

**Interfaces:**
- Produces: `DocumentClassifier` from `classify/classifier.js`. To test the pure bits, export the two helpers: `export function guessMimeType(filename, fallback)` and add `export function parseClassification(raw)` that wraps the existing JSON-parse-with-safe-default logic currently inline in `#chatClassify`.

- [ ] **Step 1: Write `src/classify/classifier.test.js`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { guessMimeType, parseClassification } from './classifier.js';

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
```

- [ ] **Step 2: Verify it fails**

Run: `mkdir -p src/classify && node --test src/classify/classifier.test.js`
Expected: FAIL — cannot find `./classifier.js`.

- [ ] **Step 3: Move, strip, and extract the two pure helpers**

```bash
git mv src/document-classifier.js src/classify/classifier.js
```
Delete every comment. Add `export` to `guessMimeType`. Extract the JSON-parse block from `#chatClassify` into an exported `parseClassification(raw)` returning the same shape (`{isAccountingDocument, confidence, docType, paymentMethod, reason}`) with the same clamping and `classification_unavailable` fallback; call it from `#chatClassify`.

- [ ] **Step 4: Fix importer**

In `src/index.js`: `import { DocumentClassifier } from './document-classifier.js';` → `'./classify/classifier.js'`.

- [ ] **Step 5: Run tests**

Run: `node --test src/classify/classifier.test.js && npm test`
Expected: classifier (3) pass; full suite 37.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move classifier into src/classify, test pure helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 6: `email/` — split client vs materialize

**Files:**
- Create: `src/email/client.js` (IMAP), `src/email/materialize.js` (attachment handling)
- Move: `src/email-service.test.js` → `src/email/materialize.test.js`
- Delete: `src/email-service.js`
- (Fixtures already live at `src/lib/fixtures/` from Task 2 and stay there — the email tests do not use them.)
- Modify importer: `src/index.js`

**Interfaces:**
- `email/materialize.js` exports: `materializeAttachments(parsedAttachments, destDir)`, `extractZipEntries(buffer, destDir, usedNames?)`, `isZipAttachment(att)`, `DEFAULT_PROCESSED_LABEL`, plus internals it needs (`normalizeDocumentContent`, `inferMime`, `uniqueName`, `writeAttachmentRecord`, `EXT_MIME`, `DOC_MAGIC`, caps). Imports `needsPngConversion, toPng, toPngFilename` from `../lib/image.js`.
- `email/client.js` exports `EmailService` with the same public methods (`fetchUnprocessedEmails`, `markAsProcessed`, `markAsSkipped`). Imports `materializeAttachments` and `DEFAULT_PROCESSED_LABEL` from `./materialize.js`.

- [ ] **Step 1: Split the file**

`git mv src/email-service.js src/email/materialize.js` after `mkdir -p src/email`. From `materialize.js` remove the `EmailService` class entirely and move it into a new `src/email/client.js` that imports `materializeAttachments` and `DEFAULT_PROCESSED_LABEL` from `./materialize.js` and keeps the `imapflow`/`mailparser`/`fs`/`path`/`os` imports it actually uses. `materialize.js` keeps `imapflow`? No — `materialize.js` drops the `ImapFlow` import; it keeps `mailparser`? No — it keeps `fs`, `path`, `os`, `AdmZip`, and the `../lib/image.js` import. Ensure `DEFAULT_PROCESSED_LABEL` is exported from `materialize.js` (or move it to `client.js` and export there — pick `materialize.js` for stability) and re-imported by `client.js`.

- [ ] **Step 2: Strip comments and fix the test import**

Delete every comment from both files. In `src/email/materialize.test.js` (moved), fix the import from `./email-service.js` → `./materialize.js`. These tests generate their own buffers (`sharp`/`AdmZip`) and reference no fixture files, so nothing under `src/lib/fixtures/` is touched here.

- [ ] **Step 3: Fix importer**

In `src/index.js`: `import { EmailService } from './email-service.js';` → `'./email/client.js'`.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: full suite 37 (the moved materialize + image tests pass at their new paths).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: split email-service into email/client + email/materialize

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 7: `pipeline/` — extract filter, summary, run

**Files:**
- Create: `src/pipeline/attachment-filter.js`, `src/pipeline/summary.js`, `src/pipeline/run.js`
- Create tests: `src/pipeline/attachment-filter.test.js`, `src/pipeline/summary.test.js`, `src/pipeline/run.test.js`
- Modify: `src/index.js` (remove the extracted code, import from `pipeline/`)

**Interfaces:**
- `attachment-filter.js` exports `isInvoiceAttachment(attachment)` and the two sets `INVOICE_ATTACHMENT_EXTENSIONS`, `INVOICE_ATTACHMENT_MIME_TYPES`.
- `summary.js` exports `buildSummaryLines(results): string[]` (the pure formatting currently inside `sendSummary`) and `sendSummary(results, notification): Promise<void>` (calls `buildSummaryLines`, escalates failures via `notification.sendAlert`, then `notification.sendSummary`).
- `run.js` exports `processInvoices(svc): Promise<results[]>` where `svc = { cfg, trivi, email, storage, notification, classifier }` (unchanged shape). Imports `isInvoiceAttachment` and `sendSummary`.

- [ ] **Step 1: Write `src/pipeline/attachment-filter.test.js`**

```javascript
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
```

- [ ] **Step 2: Write `src/pipeline/summary.test.js`**

```javascript
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
```

- [ ] **Step 3: Write `src/pipeline/run.test.js`**

```javascript
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
```

- [ ] **Step 4: Verify the three test files fail**

Run: `mkdir -p src/pipeline && node --test src/pipeline/`
Expected: FAIL — modules not found.

- [ ] **Step 5: Create the three modules by extracting from `index.js`**

- `attachment-filter.js`: move `INVOICE_ATTACHMENT_EXTENSIONS`, `INVOICE_ATTACHMENT_MIME_TYPES`, and `isInvoiceAttachment` out of `index.js`; export them; strip comments.
- `summary.js`: move `sendSummary` out of `index.js`; split its line-building into an exported pure `buildSummaryLines(results)` returning the `lines` array, and keep `sendSummary(results, notification)` which builds lines, sends the admin alert when there are failures, and calls `notification.sendSummary(lines.join('\n'))`; strip comments.
- `run.js`: move `processInvoices` out of `index.js`; `export` it; import `isInvoiceAttachment` from `./attachment-filter.js` and `sendSummary` from `./summary.js`; strip comments. Keep the `[processing]`/`[ok]`/`[skip]` logs.

- [ ] **Step 6: Trim `index.js` to import from `pipeline/`**

`index.js` now imports `processInvoices` from `./pipeline/run.js` (the handler calls it). Remove the moved definitions.

- [ ] **Step 7: Run tests**

Run: `node --test src/pipeline/ && npm test`
Expected: pipeline tests (≈9) pass; full suite ≈46.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: extract pipeline run/filter/summary from index, add pipeline tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 8: `handler.js` + config test + infra rewiring

**Files:**
- Create: `src/handler.js` (from the remainder of `index.js`); Delete `src/index.js`
- Create: `src/config.test.js`
- Modify: `Dockerfile`, `docker-compose.yml`, `terraform/lambda.tf`, `package.json`, `README.md`, `.claude/agents/*.md`, `.claude/skills/*/SKILL.md` (path references)

**Interfaces:**
- `handler.js` exports `handler(event, context)`; keeps the module-level warm-start `services` cache and `setup()`. Imports `loadConfig` (`./config.js`), `TriviAuth` (`./trivi/auth.js`), `TriviService` (`./trivi/upload.js`), `EmailService` (`./email/client.js`), `StorageService` (`./aws/storage.js`), `NotificationService` (`./aws/notifications.js`), `DocumentClassifier` (`./classify/classifier.js`), `withRetry` (`./lib/retry.js`), and `processInvoices` (`./pipeline/run.js`).

- [ ] **Step 1: Write `src/config.test.js`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

test('loadConfig reads from env when SECRET_NAME is empty', async () => {
  const prev = { ...process.env };
  delete process.env.SECRET_NAME;
  Object.assign(process.env, { EMAIL_HOST: 'h', EMAIL_PORT: '993', EMAIL_USER: 'u', EMAIL_PASSWORD: 'p', TRIVI_APP_ID: 'id', TRIVI_APP_SECRET: 'sec' });
  const cfg = await loadConfig();
  assert.equal(cfg.email.host, 'h');
  assert.equal(cfg.email.port, 993);
  assert.equal(cfg.trivi.appId, 'id');
  process.env = prev;
});

test('loadConfig throws when a required env var is missing', async () => {
  const prev = { ...process.env };
  delete process.env.SECRET_NAME;
  delete process.env.EMAIL_HOST;
  await assert.rejects(() => loadConfig(), /Missing required env var: EMAIL_HOST/);
  process.env = prev;
});
```

- [ ] **Step 2: Verify it fails/passes appropriately**

Run: `node --test src/config.test.js`
Expected: FAIL only if `config.js` still has comments? No — it should PASS already (config.js unchanged behavior). If it passes, that is fine; this test locks behavior before the header-comment strip in Step 4.

- [ ] **Step 3: Create `handler.js` from `index.js`**

```bash
git mv src/index.js src/handler.js
```
In `handler.js`, remove anything already moved to `pipeline/` (it should only retain `setup()`, the `services` cache, and `handler`). Ensure it imports `processInvoices` from `./pipeline/run.js`. Fix the `fs` import usage — if temp-file cleanup moved into `run.js`, drop the unused `fs` import from `handler.js`.

- [ ] **Step 4: Strip comments from `handler.js` and `config.js`**

Delete every comment from both.

- [ ] **Step 5: Rewire infra + scripts**

- `Dockerfile`: `CMD ["src/index.handler"]` → `CMD ["src/handler.handler"]`.
- `docker-compose.yml`: `import('./src/index.js')` → `import('./src/handler.js')`.
- `terraform/lambda.tf`: if it sets `image_config { command = ["src/index.handler"] }` or a `handler`, update to `src/handler.handler`.
- `package.json`: `"start": "node src/handler.js"`, `"dev": "node --watch src/handler.js --local"`, `"test": "node --test"`.
- `README.md`, `.claude/agents/pipeline-triage.md`, `.claude/agents/system-architect.md`, and both `.claude/skills/*/SKILL.md`: replace any `src/index.js` / old-path references with the new paths.

- [ ] **Step 6: Run tests + a load check**

Run:
```bash
npm test
node -e "import('./src/handler.js').then(m => console.log('handler export:', typeof m.handler))"
```
Expected: full suite ≈48 pass; `handler export: function`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: thin handler.js entry, config tests, rewire infra to new paths

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Docs and verification

### Task 9: Rewrite AGENTS.md and verify end-to-end

**Files:**
- Modify: `AGENTS.md`, and `README.md` / `LOCAL_AWS_SWITCH_NOTE.md` if they name old paths.

- [ ] **Step 1: Confirm no comments remain in `src/`**

Run:
```bash
grep -rnE '(^|[^:])//|/\*|\*/|^\s*\*' src --include='*.js' | grep -v '\.test\.js' | grep -vE 'https?://'
```
Expected: no output (URLs in strings are allowed; test files may keep assertion helpers but should also be comment-free — inspect any hits).

- [ ] **Step 2: Rewrite `AGENTS.md`**

Update the architecture diagram, the file/responsibility table, and the commands to the new structure (Target file structure above; `handler` entry; `npm test` = `node --test`). Remove stale items: the `src/invoice-extractor.js` row, the "no tests exist yet" note, and the `.env.example` real-secret warning. Add a "Domain knowledge (the why)" section capturing everything listed in spec Part 3: the 6 invariants, Seznam-has-no-labels, the java-serialization envelope stripping, the TRIVI payment-type enum (1=BankTransfer 2=Cash 3=COD 4=Card), the Mistral cost-routing (images→vision, PDFs→OCR), the zip safeguards, and the HEIC/HEIF/WebP/TIFF→PNG rule.

- [ ] **Step 3: Full suite + local smoke test**

Run:
```bash
npm test
node --env-file=.env -e "import('./src/handler.js').then(({handler}) => handler({}, {awsRequestId:'refactor-verify'})).then(r=>console.log(r.statusCode, r.body))"
```
Expected: all tests pass; the smoke run returns `200` (or a clean "No unprocessed emails" if INBOX is empty) with no `[error]`/`[fatal]`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: rewrite AGENTS.md for the new architecture; migrate domain knowledge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes

- The `pipeline/run.js` DI shape (`svc` object) is unchanged from today's `processInvoices(svc)` — only its location and the `export` are new, which is what makes it unit-testable with fakes.
- If `node --test` (no path) does not discover nested tests in this Node version, fall back to `node --test 'src/**/*.test.js'` in the `test` script and note it.
- Task 6 is the riskiest (splitting the largest file); keep the public `EmailService` surface and the `materializeAttachments` signature byte-for-byte identical so `index.js`/`run.js` and the moved tests need no logic change.
