# PNG conversion for TRIVI-unsupported images + TRIVI key rotation + git-history secret scrub

Date: 2026-07-02

## Problem

1. **TRIVI rejects advanced image formats.** Attachments arriving as Apple HEIC/HEIF
   (iPhone photos), WebP, and TIFF fail on upload — TRIVI only accepts common
   formats (PDF, JPEG, PNG, XML/ISDOC). Today these files reach the upload
   unchanged and are rejected.
2. **TRIVI API credentials must be rotated** to new APP ID / APP SECRET.
3. **Old secrets are committed in git history** (`.env.example`,
   `terraform/secrets.tf`) and already pushed to GitHub. They must be scrubbed
   from history.

## Scope of the three parts

### Part 1 — TRIVI key rotation

Replace the TRIVI credentials:

- `TRIVI_APP_ID`: `<OLD_TRIVI_APP_ID>` → `<NEW_TRIVI_APP_ID>`
- `TRIVI_APP_SECRET`: `<OLD_TRIVI_APP_SECRET>`
  → `<NEW_TRIVI_APP_SECRET>`

Locations:

- **`.env`** (untracked, gitignored): real new keys. Safe — never committed.
- **`.env.example`**: placeholders only for ALL secrets (no real values).
- **`terraform/secrets.tf`**: the example `put-secret-value` comment uses
  placeholders, not real values (avoid re-leaking).
- **Prod AWS Secrets Manager**: updated by the user via
  `aws secretsmanager put-secret-value` (separate manual step — prod action, not
  automated here). A ready-to-run command is provided at hand-off.

The new keys are written ONLY to the untracked `.env` and to prod Secrets
Manager — never to any tracked file — so the scrub cannot re-expose them.

### Part 2 — PNG conversion pipeline

Convert HEIC/HEIF + WebP + TIFF → PNG before the file is written to disk, so the
classifier, TRIVI upload, and S3 archive all see one canonical PNG.

**New module `src/image-conversion.js`** (pure, independently testable):

- `needsPngConversion(filename, mimeType)` → `true` for extensions
  `.heic/.heif/.webp/.tif/.tiff` or MIME `image/heic|heif|webp|tiff`.
- `toPng(buffer, ext)` → `Promise<Buffer>`, dispatching by source type:
  - HEIC/HEIF → `heic-convert` (already a dependency), `{ format: 'PNG' }`.
  - WebP/TIFF → `sharp` (new dependency), `sharp(buffer).png().toBuffer()`.
  - Rationale: `heic-convert` only reads HEIC input; prebuilt `sharp` reads WebP
    and TIFF but lacks libheif (no HEIC). Two libraries, each used where it is
    reliable. Container-image Lambda deploy (ECR, `nodejs:22` base) means the
    native `sharp` binary is not a packaging problem.

**Integration in `src/email-service.js`:**

- Unify the two file-writing paths — direct attachments in
  `materializeAttachments` and zip entries in `extractZipEntries` — through one
  helper that: (buffer, raw name, mime) → optionally convert → rename extension
  to `.png` and set `mimeType: image/png` → `uniqueName` de-dupe → path-safety
  guard → `normalizeDocumentContent` (PDF/XML only; images unaffected) → write →
  return the attachment record.
- Ordering: **convert → dedupe → normalize → write** (dedupe must run on the
  post-conversion `.png` name to avoid collisions).
- **Conversion failure** (corrupt/unreadable image): `console.warn` and SKIP that
  attachment (helper returns `null`; caller does not add it). The email is not
  failed and does not get stuck in INBOX. Other attachments continue.

**Unchanged elsewhere (verified, no edit needed):**

- `isInvoiceAttachment` (`src/index.js`): converted files are `.png` /
  `image/png` and still pass the filter. Original heic/webp/tiff entries stay in
  the allow-lists but are simply no longer hit post-conversion.
- `DocumentClassifier` in-memory HEIC→JPEG branch becomes dead for the pipeline
  (images now arrive as PNG) but remains correct and defensive; left as-is. Minor
  upside: TIFF now classifies via the cheaper vision path instead of OCR.

### Part 3 — git-history secret scrub

Old secrets present in history (each introduced in a single commit, in
`.env.example` and `terraform/secrets.tf`):

- TRIVI appId `<OLD_TRIVI_APP_ID>`
- TRIVI appSecret `<OLD_TRIVI_APP_SECRET>`
- Mistral apiKey `<OLD_MISTRAL_KEY>`

The email password was never committed (`.env` is gitignored) — confirmed via
`git log -S`.

**Tool:** `git-filter-repo`, installed via `brew install git-filter-repo`, using
`--replace-text` so the files remain present with values replaced (not the files
deleted).

**Procedure:**

1. Commit Parts 1 & 2 (feature + placeholders) first, so the working tree is
   clean before the rewrite.
2. Build a `replacements.txt` mapping each of the three secret literals to a
   placeholder (e.g. `***REDACTED***`), written to the scratchpad (never
   committed).
3. Run `git filter-repo --replace-text <file> --force`. filter-repo strips the
   `origin` remote as a safety measure.
4. Re-add `origin`:
   `git remote add origin git@github.com:diamondigital/diamondigital-invoices-agent-node.git`.
5. Verify no secret remains: `git grep` for each literal across
   `$(git rev-list --all)` returns nothing.
6. Force-push: `git push origin main --force` (and `--force --tags` if tags
   exist).

**Security notes (acknowledged with the user):**

- History was already on GitHub, so the old secrets were exposed. Scrub +
  force-push removes them from the branch but does not un-expose past leaks
  (GitHub caches, forks, PRs). TRIVI keys are rotated, so their exposure is
  neutralized.
- The **Mistral key stays valid** — user chose to scrub it from history but not
  rotate it. Residual exposure risk is accepted.
- Force-push rewrites shared history: anyone else with a clone must re-clone.

## Testing (`src/email-service.test.js`)

- `needsPngConversion`: true for each target ext and MIME; false for pdf/png/jpg.
- `toPng`: a `sharp`-generated WebP buffer and a TIFF buffer each convert to a
  buffer starting with the PNG magic bytes `\x89PNG`.
- `materializeAttachments`: a WebP attachment yields a record with a `.png`
  filename, `mimeType: image/png`, and a file on disk beginning with PNG magic.
- Conversion failure: a garbage/undecodable "image/webp" buffer is skipped (not
  present in the returned records), and other attachments in the same email are
  still returned.
- HEIC: prefer a small committed fixture that converts to PNG; if a fixture is
  impractical to produce, cover the HEIC dispatch branch instead and note it.

## Out of scope

- Changing TRIVI's accepted-format list or upload logic.
- Rotating the Mistral key (explicitly declined).
- Converting formats TRIVI already accepts (PDF/JPEG/PNG/XML/ISDOC).
