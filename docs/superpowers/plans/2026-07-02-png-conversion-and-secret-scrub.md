# PNG Conversion + TRIVI Key Rotation + Git-History Secret Scrub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcode TRIVI-unsupported image attachments (HEIC/HEIF, WebP, TIFF) to PNG before upload, rotate the TRIVI API credentials, and scrub old secrets from git history.

**Architecture:** A new pure module `src/image-conversion.js` decides which attachments need conversion and transcodes them (HEIC/HEIF via `heic-convert`, WebP/TIFF via `sharp`). `src/email-service.js` routes every written attachment — both direct attachments and zip entries — through one shared writer that converts, de-dupes, guards the path, normalizes, and writes. Credentials are rotated in the untracked `.env` and prod Secrets Manager only; tracked files get placeholders. Git history is rewritten with `git-filter-repo --replace-text`.

**Tech Stack:** Node.js 22 (ESM), `node --test`, `sharp` (new), `heic-convert` (existing), `git-filter-repo` (via Homebrew).

## Global Constraints

- Node.js ESM only (`"type": "module"`); use `import`, not `require`.
- Deploy is a container-image Lambda (`public.ecr.aws/lambda/nodejs:22`, built with `npm ci --production`) — `sharp` MUST be in `dependencies`, not `devDependencies`.
- Run all tests with `npm test` (`node --test src/**/*.test.js`); a single file with `node --test src/<file>.test.js`.
- The NEW TRIVI keys go ONLY into the untracked `.env` (gitignored) and prod Secrets Manager — NEVER into any tracked file, so the history scrub cannot re-expose them.
- New TRIVI credentials (verbatim):
  - `TRIVI_APP_ID` = `***REDACTED-TRIVI-APP-ID***`
  - `TRIVI_APP_SECRET` = `***REDACTED-TRIVI-APP-SECRET***`
- Conversion failure for one attachment must SKIP that attachment (log a `[warn]`), never throw out of `materializeAttachments` — the email must not get stuck in INBOX.
- Commit messages end with the repo's `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- **Create** `src/image-conversion.js` — pure conversion module: `needsPngConversion`, `toPng`, `toPngFilename`.
- **Create** `src/image-conversion.test.js` — unit tests for the module.
- **Create** `src/fixtures/sample.png`, `src/fixtures/sample.heic` — tiny binary fixtures for the HEIC positive test.
- **Modify** `src/email-service.js` — add a shared `writeAttachmentRecord` helper; route `materializeAttachments` and `extractZipEntries` through it.
- **Modify** `src/email-service.test.js` — add WebP-conversion and conversion-failure integration tests.
- **Modify** `.env` — new TRIVI keys (untracked, not committed).
- **Modify** `.env.example` — placeholders for all secrets.
- **Modify** `terraform/secrets.tf` — placeholders in the example command.
- **Modify** `package.json` / `package-lock.json` — add `sharp`.

---

### Task 1: `image-conversion` module

**Files:**
- Create: `src/image-conversion.js`
- Test: `src/image-conversion.test.js`
- Create fixtures: `src/fixtures/sample.png`, `src/fixtures/sample.heic`
- Modify: `package.json`, `package-lock.json` (add `sharp`)

**Interfaces:**
- Consumes: `heic-convert` default export `convertHeic({buffer, format})`; `sharp`.
- Produces:
  - `needsPngConversion(filename: string, mimeType?: string): boolean`
  - `toPng(buffer: Buffer, ext: string, mimeType?: string): Promise<Buffer>`
  - `toPngFilename(filename: string): string`

- [ ] **Step 1: Install `sharp` as a runtime dependency**

Run:
```bash
npm install sharp
```
Expected: `sharp` appears under `dependencies` in `package.json`; `package-lock.json` updated. Verify:
```bash
node -e "import('sharp').then(m=>console.log('sharp ok:', typeof m.default))"
```
Expected: `sharp ok: function`

- [ ] **Step 2: Write the failing test**

Create `src/image-conversion.test.js`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { needsPngConversion, toPng, toPngFilename } from './image-conversion.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function isPng(buf) {
  return buf.length >= 4 && buf[0] === 0x89
    && buf.subarray(1, 4).toString('latin1') === 'PNG';
}

async function makeImage(format) {
  const img = sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 128, b: 255 } },
  });
  return format === 'webp' ? img.webp().toBuffer() : img.tiff().toBuffer();
}

test('needsPngConversion: true for TRIVI-unsupported images', () => {
  assert.equal(needsPngConversion('photo.heic', ''), true);
  assert.equal(needsPngConversion('photo.HEIF', ''), true);
  assert.equal(needsPngConversion('scan.webp', ''), true);
  assert.equal(needsPngConversion('scan.tif', ''), true);
  assert.equal(needsPngConversion('scan.tiff', ''), true);
  assert.equal(needsPngConversion('noext', 'image/webp'), true); // by MIME
});

test('needsPngConversion: false for formats TRIVI accepts', () => {
  assert.equal(needsPngConversion('doc.pdf', 'application/pdf'), false);
  assert.equal(needsPngConversion('img.png', 'image/png'), false);
  assert.equal(needsPngConversion('img.jpg', 'image/jpeg'), false);
});

test('toPng converts WebP to PNG', async () => {
  const out = await toPng(await makeImage('webp'), '.webp', 'image/webp');
  assert.ok(isPng(out), 'output starts with PNG magic');
});

test('toPng converts TIFF to PNG', async () => {
  const out = await toPng(await makeImage('tiff'), '.tif', 'image/tiff');
  assert.ok(isPng(out), 'output starts with PNG magic');
});

test('toPng converts HEIC to PNG', async () => {
  const heic = await fs.readFile(path.join(here, 'fixtures', 'sample.heic'));
  const out = await toPng(heic, '.heic', 'image/heic');
  assert.ok(isPng(out), 'output starts with PNG magic');
});

test('toPng rejects an undecodable buffer', async () => {
  await assert.rejects(() => toPng(Buffer.from('not an image'), '.webp', 'image/webp'));
});

test('toPngFilename swaps the extension', () => {
  assert.equal(toPngFilename('photo.heic'), 'photo.png');
  assert.equal(toPngFilename('a.b.webp'), 'a.b.png');
  assert.equal(toPngFilename('noext'), 'noext.png');
});
```

- [ ] **Step 3: Generate the HEIC fixture (macOS `sips`)**

Run (this machine is darwin; `sips` ships with macOS):
```bash
mkdir -p src/fixtures
node -e "import('sharp').then(({default:s})=>s({create:{width:8,height:8,channels:3,background:{r:0,g:128,b:255}}}).png().toFile('src/fixtures/sample.png'))"
sips -s format heic src/fixtures/sample.png --out src/fixtures/sample.heic
file src/fixtures/sample.heic
```
Expected: `sample.heic: ISO Media, HEIF Image ...` (a valid HEIC file).

- [ ] **Step 4: Run tests to verify they fail**

Run:
```bash
node --test src/image-conversion.test.js
```
Expected: FAIL — `Cannot find module './image-conversion.js'`.

- [ ] **Step 5: Write the module**

Create `src/image-conversion.js`:
```javascript
// src/image-conversion.js — Transcode TRIVI-unsupported image formats to PNG.
// TRIVI rejects HEIC/HEIF (iPhone photos), WebP, and TIFF. We convert them to
// PNG before the attachment is written to disk, so the classifier, the TRIVI
// upload, and the S3 archive all operate on one canonical PNG.
//
// heic-convert only *reads* HEIC (and is pure JS/wasm — works anywhere);
// sharp's prebuilt binary lacks libheif but reads WebP and TIFF natively.
// So each library is used only where it is reliable.
import convertHeic from 'heic-convert';
import sharp from 'sharp';

const CONVERT_EXTS = new Set(['.heic', '.heif', '.webp', '.tif', '.tiff']);
const CONVERT_MIMES = new Set(['image/heic', 'image/heif', 'image/webp', 'image/tiff']);

function extOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

/**
 * True if the attachment is a TRIVI-unsupported image we must transcode to PNG.
 * @param {string} filename
 * @param {string} [mimeType]
 */
export function needsPngConversion(filename, mimeType) {
  const ext = extOf(filename || '');
  const mime = (mimeType || '').toLowerCase();
  return CONVERT_EXTS.has(ext) || CONVERT_MIMES.has(mime);
}

/**
 * Transcode an image buffer to PNG. HEIC/HEIF (by ext or MIME) go through
 * heic-convert; everything else (WebP, TIFF) through sharp.
 * @param {Buffer} buffer
 * @param {string} ext lowercase extension incl. dot (e.g. '.webp')
 * @param {string} [mimeType]
 * @returns {Promise<Buffer>}
 */
export async function toPng(buffer, ext, mimeType) {
  const mime = (mimeType || '').toLowerCase();
  if (ext === '.heic' || ext === '.heif' || mime === 'image/heic' || mime === 'image/heif') {
    const out = await convertHeic({ buffer, format: 'PNG' });
    return Buffer.from(out);
  }
  return sharp(buffer).png().toBuffer();
}

/** Swap a filename's extension for `.png` (adds .png if there is no extension). */
export function toPngFilename(filename) {
  const dot = filename.lastIndexOf('.');
  return (dot >= 0 ? filename.slice(0, dot) : filename) + '.png';
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
node --test src/image-conversion.test.js
```
Expected: PASS — all 7 tests.

- [ ] **Step 7: Commit**

```bash
git add src/image-conversion.js src/image-conversion.test.js src/fixtures/sample.png src/fixtures/sample.heic package.json package-lock.json
git commit -m "feat: add image-conversion module (HEIC/WebP/TIFF → PNG)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Route attachment writes through PNG conversion

**Files:**
- Modify: `src/email-service.js`
- Test: `src/email-service.test.js`

**Interfaces:**
- Consumes: `needsPngConversion`, `toPng`, `toPngFilename` from Task 1; existing `uniqueName`, `inferMime`, `normalizeDocumentContent` in `email-service.js`.
- Produces: internal `writeAttachmentRecord(rawBuffer, rawName, mimeType, destDir, usedNames): Promise<{filename,path,mimeType,sizeBytes}|null>`. Public signatures of `materializeAttachments` and `extractZipEntries` are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/email-service.test.js` (top import already has `materializeAttachments`; add `sharp`):
```javascript
import sharp from 'sharp';

async function webpBuffer() {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .webp().toBuffer();
}

test('materializeAttachments converts a WebP attachment to PNG', async () => {
  const dir = await tmpDir();
  const records = await materializeAttachments(
    [{ filename: 'receipt.webp', content: await webpBuffer(), contentType: 'image/webp' }],
    dir,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].filename, 'receipt.png');
  assert.equal(records[0].mimeType, 'image/png');
  const onDisk = await fs.readFile(records[0].path);
  assert.equal(onDisk[0], 0x89);
  assert.equal(onDisk.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(onDisk.length, records[0].sizeBytes);
});

test('materializeAttachments skips an unconvertible image but keeps others', async () => {
  const dir = await tmpDir();
  const records = await materializeAttachments(
    [
      { filename: 'broken.webp', content: Buffer.from('not an image'), contentType: 'image/webp' },
      { filename: 'good.pdf', content: Buffer.from('%PDF-1.4 body'), contentType: 'application/pdf' },
    ],
    dir,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].filename, 'good.pdf');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
node --test src/email-service.test.js
```
Expected: FAIL — WebP test expects `receipt.png`/`image/png` but current code writes `receipt.webp` unchanged.

- [ ] **Step 3: Add the import and the shared writer helper**

In `src/email-service.js`, add the import after the existing imports (below the `AdmZip` import):
```javascript
import { needsPngConversion, toPng, toPngFilename } from './image-conversion.js';
```

Add this helper just above `export async function materializeAttachments` (after `uniqueName`):
```javascript
/**
 * Convert (if needed), de-collide, path-guard, normalize, and write one
 * attachment into destDir, returning its record. Returns null when a required
 * PNG conversion fails or the file cannot be written — the caller then skips
 * that attachment so a bad file never stalls the whole email.
 * @param {Buffer} rawBuffer
 * @param {string} rawName
 * @param {string|undefined} mimeType
 * @param {string} destDir
 * @param {Set<string>} usedNames
 * @returns {Promise<{filename:string, path:string, mimeType:string, sizeBytes:number}|null>}
 */
async function writeAttachmentRecord(rawBuffer, rawName, mimeType, destDir, usedNames) {
  let data = rawBuffer;
  let baseName = path.basename(rawName);
  let outMime = mimeType;

  // TRIVI rejects HEIC/HEIF/WebP/TIFF — transcode to PNG before writing.
  if (needsPngConversion(baseName, mimeType)) {
    const dot = baseName.lastIndexOf('.');
    const ext = dot >= 0 ? baseName.slice(dot).toLowerCase() : '';
    try {
      data = await toPng(rawBuffer, ext, mimeType);
      baseName = toPngFilename(baseName);
      outMime = 'image/png';
      console.log(`[email] Converted "${rawName}" → "${baseName}" (TRIVI-safe PNG)`);
    } catch (err) {
      console.warn(`[warn] Could not convert "${rawName}" to PNG — skipping: ${err.message}`);
      return null;
    }
  }

  const filename = uniqueName(baseName, usedNames);
  const filePath = path.join(destDir, filename);

  // Defense-in-depth: the resolved path must stay inside destDir.
  if (!path.resolve(destDir, filename).startsWith(path.resolve(destDir) + path.sep)) {
    console.warn(`[warn] Skipping attachment that resolves outside destDir: "${rawName}"`);
    return null;
  }

  const content = normalizeDocumentContent(data, filename);
  try {
    await fs.writeFile(filePath, content);
  } catch (err) {
    console.warn(`[warn] Could not write attachment "${rawName}": ${err.message}`);
    return null;
  }
  return { filename, path: filePath, mimeType: outMime || inferMime(filename), sizeBytes: content.length };
}
```

- [ ] **Step 4: Route `extractZipEntries` through the helper**

In `extractZipEntries`, replace the block from `const filename = uniqueName(safeName, usedNames);` through `records.push({ filename, path: filePath, mimeType: inferMime(filename), sizeBytes: content.length });` (the unique-name, path-join, path-guard, normalize, write, and push lines) with:
```javascript
    const rec = await writeAttachmentRecord(data, safeName, inferMime(safeName), destDir, usedNames);
    if (rec) records.push(rec);
```
(The directory-skip, entry-count cap, name-safety check, byte-size cap, and `entry.getData()` try/catch above this block stay exactly as they are.)

- [ ] **Step 5: Route `materializeAttachments` (direct path) through the helper**

In `materializeAttachments`, replace the four lines after the zip branch:
```javascript
    const filename = uniqueName(path.basename(att.filename), usedNames);
    const filePath = path.join(destDir, filename);
    const content = normalizeDocumentContent(att.content, filename);
    await fs.writeFile(filePath, content);
    attachments.push({ filename, path: filePath, mimeType: att.contentType, sizeBytes: content.length });
```
with:
```javascript
    const rec = await writeAttachmentRecord(att.content, att.filename, att.contentType, destDir, usedNames);
    if (rec) attachments.push(rec);
```

- [ ] **Step 6: Run the full email-service suite to verify pass + no regression**

Run:
```bash
node --test src/email-service.test.js
```
Expected: PASS — the two new tests pass and all pre-existing zip/collision tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/email-service.js src/email-service.test.js
git commit -m "feat: convert HEIC/WebP/TIFF attachments to PNG before upload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rotate TRIVI keys and replace tracked secrets with placeholders

**Files:**
- Modify: `.env` (untracked — NOT committed)
- Modify: `.env.example`
- Modify: `terraform/secrets.tf`

**Interfaces:** none (config/text only).

- [ ] **Step 1: Put the new TRIVI keys in the untracked `.env`**

Edit `.env` lines 18–19 to:
```
TRIVI_APP_ID=***REDACTED-TRIVI-APP-ID***
TRIVI_APP_SECRET=***REDACTED-TRIVI-APP-SECRET***
```
Leave the rest of `.env` (email password, Mistral key) unchanged.

- [ ] **Step 2: Confirm `.env` is not tracked**

Run:
```bash
git status --porcelain .env
git check-ignore .env
```
Expected: `git status` prints nothing for `.env`; `git check-ignore` prints `.env` (it is ignored). Do NOT `git add .env`.

- [ ] **Step 3: Replace all secrets in `.env.example` with placeholders**

Edit `.env.example` so no real values remain. Set:
```
EMAIL_PASSWORD=<EMAIL_PASSWORD>
```
```
TRIVI_APP_ID=<TRIVI_APP_ID>
TRIVI_APP_SECRET=<TRIVI_APP_SECRET>
```
```
MISTRAL_API_KEY=<MISTRAL_API_KEY>
```
(Leave non-secret example values such as `EMAIL_HOST`, `TRIVI_BASE_URL`, folder names, and thresholds as they are.)

- [ ] **Step 4: Replace real values in the `terraform/secrets.tf` comment with placeholders**

Edit the `--secret-string` example JSON in the comment so it contains no real credentials — replace the `password`, `trivi.appId`, `trivi.appSecret`, and `mistral.apiKey` values with `<...>` placeholders, e.g.:
```
#   --secret-string '{"email":{"host":"imap.seznam.cz","port":993,"secure":true,"user":"invoices@diamondigital.cz","password":"<EMAIL_PASSWORD>"},"trivi":{"appId":"<TRIVI_APP_ID>","appSecret":"<TRIVI_APP_SECRET>","baseUrl":"https://api.trivi.com/v2","bankAccountId":0},"mistral":{"apiKey":"<MISTRAL_API_KEY>","model":"mistral-large-latest"},"notification":{"snsTopicArn":"","adminEmail":"admin@diamondigital.cz"},"s3":{"bucketName":"diamondigital-invoices-archive"}}'
```

- [ ] **Step 5: Verify no real secret remains in tracked files**

Run:
```bash
grep -rn -e ***REDACTED-TRIVI-APP-ID*** \
        -e ***REDACTED-TRIVI-APP-SECRET*** \
        -e ***REDACTED-MISTRAL-KEY*** \
        -e ***REDACTED-TRIVI-APP-ID*** \
        -e ***REDACTED-TRIVI-APP-SECRET*** \
        .env.example terraform/secrets.tf
```
Expected: no output (neither old nor new secrets appear in the tracked files).

- [ ] **Step 6: Commit the placeholder changes only**

```bash
git add .env.example terraform/secrets.tf
git commit -m "chore: replace secrets in tracked files with placeholders

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Scrub old secrets from git history and force-push

**Files:** none in-repo (history rewrite + push). A `replacements.txt` is written to the scratchpad, never committed.

**Interfaces:** none.

> Run this task ONLY after Tasks 1–3 are committed and `git status` is clean. This rewrites all commits and force-pushes; anyone else with a clone must re-clone.

- [ ] **Step 1: Confirm a clean working tree**

Run:
```bash
git status --porcelain
```
Expected: no output (clean). If not clean, stop and resolve before proceeding.

- [ ] **Step 2: Install `git-filter-repo`**

Run:
```bash
brew install git-filter-repo
git filter-repo --version
```
Expected: a version string prints.

- [ ] **Step 3: Write the replacement map to the scratchpad**

Write this file to `/private/tmp/claude-501/-Users-jakubinger-Documents-development-diamondigital-diamondigital-invoices-agent-node/56b1ec3b-e0e4-46e5-b8da-7f4aa7ef8689/scratchpad/replacements.txt`:
```
***REDACTED-TRIVI-APP-ID***==>***REDACTED-TRIVI-APP-ID***
***REDACTED-TRIVI-APP-SECRET***==>***REDACTED-TRIVI-APP-SECRET***
***REDACTED-MISTRAL-KEY***==>***REDACTED-MISTRAL-KEY***
```

- [ ] **Step 4: Rewrite history**

Run (from the repo root):
```bash
git filter-repo --replace-text "/private/tmp/claude-501/-Users-jakubinger-Documents-development-diamondigital-diamondigital-invoices-agent-node/56b1ec3b-e0e4-46e5-b8da-7f4aa7ef8689/scratchpad/replacements.txt" --force
```
Expected: filter-repo reports a completed rewrite of the commits. It removes the `origin` remote as a safety measure.

- [ ] **Step 5: Verify the secrets are gone from ALL history**

Run:
```bash
git grep -n -e ***REDACTED-TRIVI-APP-ID*** \
           -e ***REDACTED-TRIVI-APP-SECRET*** \
           -e ***REDACTED-MISTRAL-KEY*** \
           $(git rev-list --all)
```
Expected: no output (exit status 1). If any line prints, stop — the rewrite did not fully apply.

- [ ] **Step 6: Re-add the origin remote**

Run:
```bash
git remote add origin git@github.com:diamondigital/diamondigital-invoices-agent-node.git
git remote -v
```
Expected: `origin` points to the GitHub repo (fetch + push).

- [ ] **Step 7: Force-push the rewritten history**

Run:
```bash
git push origin main --force
```
Expected: the push succeeds with a `(forced update)` note.

- [ ] **Step 8: Hand off the prod Secrets Manager update (user runs it)**

Do NOT run this — surface it to the user to run themselves (per repo memory, secrets are set via AWS CLI, not `terraform apply`). Provide the exact command with the new TRIVI keys filled in and the other secret fields carried over from the current secret value:
```bash
aws secretsmanager put-secret-value \
  --secret-id diamondigital-invoices-agent-node \
  --secret-string '{"email":{...},"trivi":{"appId":"***REDACTED-TRIVI-APP-ID***","appSecret":"***REDACTED-TRIVI-APP-SECRET***","baseUrl":"https://api.trivi.com/v2","bankAccountId":0},"mistral":{...},"notification":{...},"s3":{...}}'
```
Tell the user to first fetch the current value (`aws secretsmanager get-secret-value --secret-id diamondigital-invoices-agent-node`) so the non-TRIVI fields are preserved, then swap only the two TRIVI fields.

---

## Notes carried from the spec

- `isInvoiceAttachment` (`src/index.js`) needs no change: converted files are `.png`/`image/png` and still pass the filter.
- The `DocumentClassifier` in-memory HEIC branch is left as-is (defensive; images now arrive pre-converted).
- Reminder: the Mistral key stays valid — it is only scrubbed from history, not rotated (user's explicit choice). Its prior GitHub exposure is an accepted residual risk.
