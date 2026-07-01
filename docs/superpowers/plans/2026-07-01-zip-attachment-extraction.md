# Zip Attachment Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unpack `.zip` email attachments at parse time so the files inside flow through the existing invoice-processing pipeline.

**Architecture:** All new logic lives in `src/email-service.js`. Two exported helpers — `isZipAttachment` (detection) and `extractZipEntries` (unpack a zip buffer to disk) — are composed by a new `materializeAttachments` helper that replaces the inline attachment-writing loop in `fetchUnprocessedEmails`. Extracted files become ordinary attachment records, so `index.js`, the classifier, TRIVI upload, and temp-file cleanup are unchanged.

**Tech Stack:** Node.js (ESM, `"type": "module"`), `adm-zip` (pure-JS zip reader), `node:test` + `node:assert/strict`.

## Global Constraints

- ESM only (`import`/`export`); no `require`, no CommonJS.
- Logs are English with an `[area]` prefix (`[email]`, `[warn]`); user-facing strings stay Czech (none added here).
- Best-effort: a bad zip must NOT throw out of `materializeAttachments` — one email's failure must never abort the batch.
- Zip-slip guard: output filenames use `path.basename()` of the entry name only.
- Caps: `MAX_ZIP_ENTRIES = 50`, `MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024`.
- Nested zips are NOT expanded (one level only).
- Dependency `adm-zip` must be a production dependency so `npm ci --production` bundles it into the Lambda image.

---

## File Structure

- Modify: `src/email-service.js` — add imports, constants, `isZipAttachment`, `extractZipEntries`, `materializeAttachments`; replace the inline attachment loop.
- Create: `src/email-service.test.js` — unit tests for the three helpers.
- Modify: `package.json` — add `adm-zip` dependency.

---

### Task 1: `adm-zip` dependency + `extractZipEntries` / `isZipAttachment` helpers

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/email-service.js` (imports at top ~line 1-6; new constants + helpers after `DEFAULT_PROCESSED_LABEL`, ~line 12)
- Test: `src/email-service.test.js` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `export function isZipAttachment(att): boolean` — `att` is `{filename?, contentType?, mimeType?}`.
  - `export async function extractZipEntries(buffer: Buffer, destDir: string, usedNames?: Set<string>): Promise<Array<{filename:string, path:string, mimeType:string, sizeBytes:number}>>` — writes each non-directory entry into `destDir`, returns attachment records. `usedNames` tracks taken filenames for collision-avoidance (mutated).

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install adm-zip@^0.5.16
```
Expected: `package.json` gains `"adm-zip": "^0.5.16"` under `dependencies`, and `package-lock.json` updates. Confirm it landed under `dependencies` (not `devDependencies`):
```bash
node -e "console.log(require('./package.json').dependencies['adm-zip'])"
```
Expected: prints a version like `^0.5.16`.

- [ ] **Step 2: Write the failing tests**

Create `src/email-service.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';

import { isZipAttachment, extractZipEntries } from './email-service.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ziptest-'));
}

function zipOf(entries) {
  const zip = new AdmZip();
  for (const [name, content] of entries) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

test('isZipAttachment detects by mime and by extension', () => {
  assert.equal(isZipAttachment({ filename: 'x.pdf', contentType: 'application/zip' }), true);
  assert.equal(isZipAttachment({ filename: 'x.zip', contentType: 'application/octet-stream' }), true);
  assert.equal(isZipAttachment({ filename: 'X.ZIP', contentType: '' }), true);
  assert.equal(isZipAttachment({ filename: 'x.pdf', contentType: 'application/pdf' }), false);
});

test('extractZipEntries writes each file and returns records', async () => {
  const dir = await tmpDir();
  const buf = zipOf([['a.pdf', 'PDF-A'], ['b.jpg', 'JPG-B']]);
  const records = await extractZipEntries(buf, dir);
  assert.equal(records.length, 2);
  const names = records.map((r) => r.filename).sort();
  assert.deepEqual(names, ['a.pdf', 'b.jpg']);
  assert.equal(records[0].mimeType, 'application/pdf');
  for (const r of records) {
    assert.equal(path.dirname(r.path), dir);
    assert.equal((await fs.readFile(r.path)).length, r.sizeBytes);
  }
});

test('extractZipEntries guards against zip-slip', async () => {
  const dir = await tmpDir();
  const buf = zipOf([['../evil.pdf', 'X']]);
  const records = await extractZipEntries(buf, dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].filename, 'evil.pdf');
  assert.equal(path.dirname(records[0].path), dir);
});

test('extractZipEntries returns [] for a corrupt buffer without throwing', async () => {
  const dir = await tmpDir();
  const records = await extractZipEntries(Buffer.from('this is not a zip'), dir);
  assert.deepEqual(records, []);
});

test('extractZipEntries disambiguates colliding basenames', async () => {
  const dir = await tmpDir();
  const buf = zipOf([['x.pdf', 'ONE'], ['sub/x.pdf', 'TWO']]);
  const records = await extractZipEntries(buf, dir);
  assert.equal(records.length, 2);
  const names = records.map((r) => r.filename).sort();
  assert.deepEqual(names, ['1_x.pdf', 'x.pdf']);
});

test('extractZipEntries caps entry count at 50', async () => {
  const dir = await tmpDir();
  const entries = [];
  for (let i = 0; i < 60; i += 1) entries.push([`f${i}.pdf`, `n${i}`]);
  const records = await extractZipEntries(zipOf(entries), dir);
  assert.equal(records.length, 50);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
npm test
```
Expected: FAIL — `isZipAttachment`/`extractZipEntries` are not exported yet (import error or "is not a function").

- [ ] **Step 4: Add the import**

In `src/email-service.js`, add after the existing `os` import (line ~6):
```js
import AdmZip from 'adm-zip';
```

- [ ] **Step 5: Add constants and helpers**

In `src/email-service.js`, after the `DEFAULT_PROCESSED_LABEL` export (line ~12), add:
```js
// Zip-attachment expansion safeguards (see docs spec 2026-07-01).
const MAX_ZIP_ENTRIES = 50;
const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024;

const EXT_MIME = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.xml': 'application/xml',
  '.isdoc': 'application/xml',
};

function inferMime(filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  return EXT_MIME[ext] || 'application/octet-stream';
}

// Return `name`, or `${i}_name` for the first i that isn't already taken.
// Mutates `usedNames` with the chosen result.
function uniqueName(name, usedNames) {
  let candidate = name;
  let i = 1;
  while (usedNames.has(candidate)) {
    candidate = `${i}_${name}`;
    i += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * True if an attachment is a zip, by MIME (application/zip,
 * application/x-zip-compressed) or by a .zip filename (Seznam sometimes sends
 * zips as application/octet-stream).
 * @param {{filename?:string, contentType?:string, mimeType?:string}} att
 */
export function isZipAttachment(att) {
  const name = (att.filename || '').toLowerCase();
  const mime = (att.contentType || att.mimeType || '').toLowerCase();
  return (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    name.endsWith('.zip')
  );
}

/**
 * Unpack a zip buffer into destDir. Best-effort: a corrupt/unreadable zip or
 * entry is logged and skipped rather than thrown. Directory entries are
 * ignored; entry names are flattened to basename (zip-slip guard); count and
 * total uncompressed size are capped.
 * @param {Buffer} buffer
 * @param {string} destDir
 * @param {Set<string>} [usedNames]
 * @returns {Promise<Array<{filename:string, path:string, mimeType:string, sizeBytes:number}>>}
 */
export async function extractZipEntries(buffer, destDir, usedNames = new Set()) {
  const records = [];
  let entries;
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch (err) {
    console.warn(`[warn] Could not open zip attachment: ${err.message}`);
    return records;
  }

  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (records.length >= MAX_ZIP_ENTRIES) {
      console.warn(`[warn] Zip entry limit (${MAX_ZIP_ENTRIES}) reached — skipping remaining entries`);
      break;
    }
    const safeName = path.basename(entry.entryName);
    if (!safeName) continue;

    let data;
    try {
      data = entry.getData(); // throws on encrypted/corrupt entries
    } catch (err) {
      console.warn(`[warn] Skipping unreadable zip entry "${entry.entryName}": ${err.message}`);
      continue;
    }

    totalBytes += data.length;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      console.warn('[warn] Zip uncompressed size limit reached — skipping remaining entries');
      break;
    }

    const filename = uniqueName(safeName, usedNames);
    const filePath = path.join(destDir, filename);
    await fs.writeFile(filePath, data);
    records.push({ filename, path: filePath, mimeType: inferMime(filename), sizeBytes: data.length });
  }

  return records;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
npm test
```
Expected: PASS — all 6 tests green.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/email-service.js src/email-service.test.js
git commit --author="info@diamondigital.cz <info@diamondigital.cz>" -m "feat: add zip extraction helpers to email-service"
```

---

### Task 2: `materializeAttachments` + wire into `fetchUnprocessedEmails`

**Files:**
- Modify: `src/email-service.js` (add `materializeAttachments`; replace the inline loop at lines ~71-82)
- Test: `src/email-service.test.js` (append tests)

**Interfaces:**
- Consumes: `isZipAttachment`, `extractZipEntries` from Task 1.
- Produces:
  - `export async function materializeAttachments(parsedAttachments: Array<{filename?:string, content:Buffer, contentType?:string, size?:number}>, destDir: string): Promise<Array<{filename:string, path:string, mimeType:string, sizeBytes:number}>>` — writes each attachment to `destDir`; zips are expanded via `extractZipEntries`; the zip itself is not added.

- [ ] **Step 1: Write the failing tests**

Append to `src/email-service.test.js`:
```js
import { materializeAttachments } from './email-service.js';

test('materializeAttachments expands zips and passes through normal files', async () => {
  const dir = await tmpDir();
  const zipBuf = zipOf([['inv1.pdf', 'A'], ['inv2.pdf', 'B']]);
  const parsed = [
    { filename: 'pack.zip', content: zipBuf, contentType: 'application/zip', size: zipBuf.length },
    { filename: 'direct.pdf', content: Buffer.from('DIRECT'), contentType: 'application/pdf', size: 6 },
  ];
  const records = await materializeAttachments(parsed, dir);
  const names = records.map((r) => r.filename).sort();
  assert.deepEqual(names, ['direct.pdf', 'inv1.pdf', 'inv2.pdf']);
  assert.equal(records.find((r) => r.filename === 'pack.zip'), undefined);
});

test('materializeAttachments skips a corrupt zip but keeps other attachments', async () => {
  const dir = await tmpDir();
  const parsed = [
    { filename: 'bad.zip', content: Buffer.from('nope'), contentType: 'application/zip', size: 4 },
    { filename: 'good.pdf', content: Buffer.from('OK'), contentType: 'application/pdf', size: 2 },
  ];
  const records = await materializeAttachments(parsed, dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].filename, 'good.pdf');
});

test('materializeAttachments skips attachments with no filename', async () => {
  const dir = await tmpDir();
  const parsed = [{ content: Buffer.from('X'), contentType: 'application/pdf', size: 1 }];
  const records = await materializeAttachments(parsed, dir);
  assert.deepEqual(records, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test
```
Expected: FAIL — `materializeAttachments` is not exported yet.

- [ ] **Step 3: Add `materializeAttachments`**

In `src/email-service.js`, add directly after `extractZipEntries`:
```js
/**
 * Turn mailparser attachments into pipeline attachment records in destDir.
 * Zip attachments are expanded (the zip itself is dropped); everything else is
 * written through. Filenames are de-collided across the whole email.
 * @param {Array<{filename?:string, content:Buffer, contentType?:string, size?:number}>} parsedAttachments
 * @param {string} destDir
 * @returns {Promise<Array<{filename:string, path:string, mimeType:string, sizeBytes:number}>>}
 */
export async function materializeAttachments(parsedAttachments, destDir) {
  const attachments = [];
  const usedNames = new Set();
  for (const att of parsedAttachments) {
    if (!att.filename) continue;

    if (isZipAttachment(att)) {
      console.log(`[email] Expanding zip attachment: ${att.filename}`);
      const extracted = await extractZipEntries(att.content, destDir, usedNames);
      console.log(`[email] Extracted ${extracted.length} file(s) from ${att.filename}`);
      attachments.push(...extracted);
      continue;
    }

    const filename = uniqueName(path.basename(att.filename), usedNames);
    const filePath = path.join(destDir, filename);
    await fs.writeFile(filePath, att.content);
    attachments.push({ filename, path: filePath, mimeType: att.contentType, sizeBytes: att.size });
  }
  return attachments;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm test
```
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Replace the inline loop in `fetchUnprocessedEmails`**

In `src/email-service.js`, find (lines ~71-82):
```js
          const attachments = [];
          for (const att of parsed.attachments || []) {
            if (!att.filename) continue;
            const filePath = path.join(tempDir, att.filename);
            await fs.writeFile(filePath, att.content);
            attachments.push({
              filename: att.filename,
              path: filePath,
              mimeType: att.contentType,
              sizeBytes: att.size,
            });
          }
```
Replace with:
```js
          const attachments = await materializeAttachments(parsed.attachments || [], tempDir);
```

- [ ] **Step 6: Run the full test suite**

Run:
```bash
npm test
```
Expected: PASS — all 9 tests green (the wiring change is not unit-tested but must not break existing tests).

- [ ] **Step 7: Commit**

```bash
git add src/email-service.js src/email-service.test.js
git commit --author="info@diamondigital.cz <info@diamondigital.cz>" -m "feat: expand zip attachments during email parsing"
```

---

## Notes for the implementer

- The wiring change (Task 2, Step 5) also flattens direct-attachment filenames to
  `path.basename(...)` and de-collides them — a deliberate, safer change from the previous
  behaviour that used `att.filename` verbatim.
- Do not `git push` unless the user asks: a push to `main` triggers the GitHub Actions
  deploy to Lambda. Optionally verify end-to-end with the `local-smoke-test` skill first.
