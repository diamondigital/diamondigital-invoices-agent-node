# AGENTS.md — diamondigital-invoices-agent-node

Project rules for AI agents (and humans) working in this repo. Follow them. If the
code contradicts this document, trust the code and fix the description here.

The source is comment-free by design (clean-architecture refactor) — this document
is the single source of truth for the "why" behind non-obvious decisions. When you
learn something surprising about the code, add it here instead of a code comment.

## What it does (one sentence)

The agent pulls **unprocessed emails** from a mailbox (IMAP, Seznam), classifies
**invoice-like attachments** with Mistral, and uploads the ones that qualify to
**TRIVI "uploaded documents"**. It runs as an **AWS Lambda** (cron via EventBridge);
locally via `docker-compose` or `node --watch`.

> This is **not** full invoice issuing — only attachment upload into TRIVI's
> "uploaded documents" inbox for manual/automatic accounting there.

## Architecture & data flow

Entry point: `handler` in [src/handler.js](src/handler.js).

```
handler (Lambda)
  └─ setup()                                  # warm-start: services cached across invocations (module-level `services`)
       loadConfig()                           # SECRET_NAME set → Secrets Manager; else .env
  └─ processInvoices(svc)                     # src/pipeline/run.js
       1. email.fetchUnprocessedEmails()      # everything in INBOX = unprocessed
       2. for each email (isolated):
            filter isInvoiceAttachment()      # by extension OR MIME type
            for each qualifying attachment:
              classifier.classifyAttachment() # Mistral: is it an accounting doc? (skip if disabled)
              trivi.uploadDocumentAttachment() # wrapped in withRetry(3×, exp backoff); two-step upload→scan
            storage.archiveEmail()            # S3, best-effort (warn-only on failure)
            email.markAsProcessed/markAsSkipped() # move email out of INBOX → "TRIVI" or "Bez dokladu" folder
            cleanup temp attachments
       3. sendSummary()                       # SNS summary (Czech) + escalate failures to admin
```

Layers (one file = one responsibility):

| File | Responsibility |
|---|---|
| [src/handler.js](src/handler.js) | Lambda entry: `setup()` (wires services, wraps upload in retry) + `handler` |
| [src/config.js](src/config.js) | Config loading: Secrets Manager (prod) vs `.env` (local) |
| [src/pipeline/run.js](src/pipeline/run.js) | `processInvoices(svc)` — the per-email orchestration loop |
| [src/pipeline/attachment-filter.js](src/pipeline/attachment-filter.js) | `isInvoiceAttachment` — extension/MIME allowlist |
| [src/pipeline/summary.js](src/pipeline/summary.js) | `buildSummaryLines` + `sendSummary` — the daily Czech report |
| [src/email/client.js](src/email/client.js) | `EmailService` — IMAP: fetch INBOX, parse, move to folder |
| [src/email/materialize.js](src/email/materialize.js) | Zip expansion, PNG conversion, byte-envelope normalization, MIME inference |
| [src/trivi/auth.js](src/trivi/auth.js) | `TriviAuth` — bearer token cache/refresh (5 min buffer) |
| [src/trivi/upload.js](src/trivi/upload.js) | `TriviService.uploadDocumentAttachment` — the two-step TRIVI upload |
| [src/classify/classifier.js](src/classify/classifier.js) | `DocumentClassifier` — Mistral accounting-document classification |
| [src/aws/storage.js](src/aws/storage.js) | S3 audit archive (best-effort) |
| [src/aws/notifications.js](src/aws/notifications.js) | SNS summaries + alerts |
| [src/lib/image.js](src/lib/image.js) | `needsPngConversion`, `toPng`, `toPngFilename` |
| [src/lib/retry.js](src/lib/retry.js) | `withRetry` — generic exponential-backoff wrapper |

Infra: [terraform/](terraform/) (ECR, EventBridge, IAM, Lambda, S3, Secrets, SNS),
[Dockerfile](Dockerfile) (AWS Lambda nodejs:22 base), [docker-compose.yml](docker-compose.yml) (local run).
Local ↔ AWS switching is documented in [LOCAL_AWS_SWITCH_NOTE.md](LOCAL_AWS_SWITCH_NOTE.md).

## Domain knowledge (the why)

These are decisions that aren't obvious from reading the code in isolation. Keep
this section current — it's the only place they're written down.

1. **The 6 invariants — do not break these:**
   1. **An email is marked processed (moved out of INBOX) ONLY after a successful
      upload.** `result.success` gates `markAsProcessed` in
      [src/pipeline/run.js](src/pipeline/run.js). Never mark an email processed
      before it is uploaded to TRIVI.
   2. **"Processed" state = email outside INBOX.** Seznam IMAP has no
      labels/keywords, so the marker is moving the message into a folder (default
      `TRIVI`, env `EMAIL_PROCESSED_LABEL`; skipped ones go to `Bez dokladu`, env
      `EMAIL_SKIPPED_FOLDER`). Anything left in INBOX is reprocessed on the next run.
   3. **Per-email error isolation.** One email failing must not abort the others —
      hence the try/catch inside the loop in `processInvoices`. Only an IMAP fetch
      failure is fatal (rethrow → DLQ).
   4. **No deduplication.** If the upload succeeds but `markAsProcessed` fails, the
      email stays in INBOX and is **uploaded again next run → duplicate in TRIVI**.
      Keep this in mind whenever you touch the upload↔move ordering (see triage
      runbook).
   5. **S3 archive and SNS are optional and best-effort** — an empty `S3_BUCKET` /
      `SNS_TOPIC_ARN` means "log only", not an error.
   6. **A TRIVI upload returning HTML instead of JSON = wrong endpoint.**
      `uploadDocumentAttachment` detects this (`<!doctype`) on both the `/uploads`
      and `/accountingdocuments/scans` responses and throws a clear error. Do not
      remove that guard.

2. **Seznam has no IMAP labels.** There's no flag/keyword to mark a message
   processed — the only durable state Seznam gives us is which folder a message
   lives in. That's why "processed" and "skipped" are modeled as folder moves, not
   flags, and why INBOX itself is the unprocessed queue.

3. **The java-serialization envelope strip.** Some Java-based senders (notably the
   ČÚZK cadastre portal) deliver PDF/XML documents — inside a zip — wrapped in a
   `java.io` byte[] serialization envelope (a stream header like
   `0xAC 0xED 0x00 0x05 ...` prepended before the real content). TRIVI rejects
   these as `application/octet-stream` because they don't start with `%PDF` /
   `<?xml`. Mistral OCR is lenient and reads them anyway, so the problem doesn't
   surface until the TRIVI upload. `normalizeDocumentContent` in
   [src/email/materialize.js](src/email/materialize.js) strips any leading bytes
   before the expected magic marker for `.pdf`/`.xml`/`.isdoc`, for both zip
   entries and direct attachments.

4. **TRIVI payment-type enum.** `uploadDocumentAttachment` maps the classifier's
   `paymentMethod` string to TRIVI's numeric `paymentType` via
   `PAYMENT_TYPE_CODES` in [src/trivi/upload.js](src/trivi/upload.js):
   `bank_transfer=1, cash=2, cod=3, card=4`. `unknown`/missing omits the field
   entirely rather than guessing.

5. **Mistral cost-routing.** `DocumentClassifier.classifyAttachment` in
   [src/classify/classifier.js](src/classify/classifier.js) routes by MIME type to
   keep cost down: images (`png`/`jpeg`/`webp` — HEIC/HEIF are converted to JPEG
   first) go straight to the vision chat model; everything else (PDFs) goes
   through Mistral OCR first and the extracted text is then classified by the same
   cheap chat model. Only one LLM call per attachment either way.

6. **Zip safeguards.** [src/email/materialize.js](src/email/materialize.js) caps
   zip expansion at `MAX_ZIP_ENTRIES = 50` entries and
   `MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024` uncompressed bytes (checked against
   the zip header's declared size *before* decompressing, so a size-lie in the
   header can't be used to force a full decompress). Entry names are resolved with
   `path.basename` and rejected if empty/`.`/`..`, and the final write path is
   verified to stay inside `destDir` (zip-slip guard) before anything is written.

7. **HEIC/HEIF/WebP/TIFF → PNG.** TRIVI only reliably accepts PDF/JPEG/PNG.
   `needsPngConversion` in [src/lib/image.js](src/lib/image.js) flags
   `.heic/.heif/.webp/.tif/.tiff` (by extension or MIME) for conversion:
   HEIC/HEIF go through `heic-convert`, everything else through `sharp`. This
   happens once, in `materializeAttachments`, before classification or upload —
   so both the classifier and TRIVI only ever see a TRIVI-safe PNG.

## Configuration

- `SECRET_NAME` set → everything from AWS Secrets Manager (JSON with the same shape as
  `loadFromEnv`).
- `SECRET_NAME` empty → from env vars (`.env`). See [.env.example](.env.example).
- Required env (else `requireEnv` throws): `EMAIL_HOST/PORT/USER/PASSWORD`,
  `TRIVI_APP_ID/TRIVI_APP_SECRET`.
- `MISTRAL_API_KEY` is optional but strongly recommended: if unset, classification
  is disabled and **every** invoice-like attachment is uploaded unfiltered.

## Commands

```bash
npm start          # node src/handler.js
npm run dev        # node --watch src/handler.js --local
npm test           # node --test (discovers **/*.test.js under src/)
docker compose up --build   # local run without AWS (see docker-compose.yml)
```

ESM project (`"type": "module"`) — use `import`, not `require`.
Node 22, built-in test runner only (`node:test`) — no Jest/Vitest.

## Security — important

- `.env` is in `.gitignore` — keep it that way. [.env.example](.env.example) holds
  placeholders only; never replace them with real credentials.
- In prod, secrets belong in Secrets Manager, not in env files.

## Conventions

- The source is comment-free; logs are prefixed with `[area]` (`[trivi]`,
  `[trivi-auth]`, `[email]`, `[retry]`, `[lambda]`, `[classify]`, `[storage]`,
  `[notification]`, `[setup]`). Keep this style. Domain "why" belongs in this file,
  not in code comments.
- User-facing text (daily summary, alerts) is **in Czech**; internal logs are in English.
- One class/concern per file, grouped by domain folder (`email/`, `trivi/`,
  `classify/`, `aws/`, `pipeline/`, `lib/`). Add new integrations as their own file
  under the relevant folder.

## How to work in this repo (agents & skills)

- **Diagnosing a failed run** → agent `pipeline-triage` (`.claude/agents/`).
- **Mapping an issue/feature to code, and architecture** → agent `system-architect`.
- **Before committing** → skill `pre-commit-review` (secrets, invariants above).
- **Verifying a local run** → skill `local-smoke-test`.

Workflow: understand first (system-architect / read the relevant layer), then change,
then verify (local-smoke-test), then review (pre-commit-review). On a bug, start with
triage, not guesses.
