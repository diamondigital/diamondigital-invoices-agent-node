# Zip attachment extraction — design

**Date:** 2026-07-01
**Status:** Approved

## Problem

Invoices occasionally arrive as `.zip` attachments. The current pipeline filters
attachments through `isInvoiceAttachment` (extension / MIME allow-list) in `index.js`;
a zip is not invoice-like, so it is dropped and the email lands in the "Bez dokladu"
folder even though it may contain valid accounting documents. We want to unpack zips and
process their contents.

## Approach

Expand zips at parse time in `email-service.js`, inside the loop that materializes
attachments to the per-email temp directory. When an attachment is a zip, do **not** add
the zip itself as an attachment — instead extract its entries and add each contained file
as a normal attachment (`{filename, path, mimeType, sizeBytes}`). Everything downstream
(`isInvoiceAttachment` filter, Mistral classifier, TRIVI upload, temp-file cleanup) stays
unchanged, because extracted files are indistinguishable from directly-attached files.

This keeps the change isolated to one function and adds no new branches to the pipeline in
`index.js`.

## Detection

Treat an attachment as a zip when **either**:

- `mimeType` ∈ { `application/zip`, `application/x-zip-compressed` }, **or**
- the filename ends with `.zip` (case-insensitive).

The extension check is required because Seznam sometimes delivers zips as
`application/octet-stream`.

## Extraction

Library: **`adm-zip`** — pure JavaScript, no native dependencies (works in the Lambda
container image via `npm ci --production`). `att.content` from mailparser is already a
`Buffer` in memory, so extraction reads `new AdmZip(att.content)` with no intermediate
write of the zip to disk.

For each entry:

- Skip directory entries.
- **Zip-slip guard:** derive the output filename with `path.basename(entryName)` only;
  never use any directory component from the archive. This prevents writing outside the
  temp directory.
- Write the entry's data into the **same** per-email temp directory used by other
  attachments. On filename collision (with another entry or an existing attachment),
  prefix the name with a running counter (e.g. `1_invoice.pdf`).
- Push an attachment record `{ filename, path, mimeType, sizeBytes }`. `mimeType` is
  inferred from the file extension where known, else `application/octet-stream`;
  `sizeBytes` is the uncompressed entry size. Downstream `isInvoiceAttachment` and the
  classifier decide whether it is a real document.

## Zip-bomb safeguards

- Max entries per zip: **50**. Further entries are skipped with a `[warn]`.
- Max total uncompressed bytes per zip: **100 MB**. Once exceeded, remaining entries are
  skipped with a `[warn]`.

These are constants at the top of the module; no new env config.

## Error handling (best-effort)

- A corrupt or password-protected zip (adm-zip throws) is logged with `[warn]` and the
  **entire** zip is skipped. The email is not failed — this preserves per-email error
  isolation.
- **Nested zips are not expanded** (only one level). An extracted `.zip` will not pass
  `isInvoiceAttachment`, so it is simply dropped — no special handling needed.
- Logs are English, prefixed `[email]` / `[warn]`, matching existing style.

## Testing

`src/email-service.test.js` (`node:test`), testing the extraction unit in isolation:

1. Valid zip with 2 files → 2 attachments with correct names/paths.
2. Zip-slip entry name `../evil.pdf` → written as `evil.pdf` inside the temp dir only.
3. Corrupt zip buffer → 0 attachments, no throw.
4. Filename collision between two entries → second gets a counter prefix; both present.
5. Entry-count limit → entries beyond 50 skipped.

To keep the extraction testable in isolation, factor it into an exported helper (e.g.
`extractZipEntries(buffer, destDir)` returning attachment records) that the parse loop
calls; the test drives the helper directly with in-memory zip buffers.

## Dependency

Add `adm-zip` to `package.json` dependencies. It is bundled into the Lambda image by the
existing `npm ci --production` step in the Dockerfile — no infra change.

## Out of scope

- Recursive / nested zip extraction.
- Password-protected zips.
- Other archive formats (rar, 7z, tar).
