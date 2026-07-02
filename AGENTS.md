# AGENTS.md — diamondigital-invoices-agent-node

Project rules for AI agents (and humans) working in this repo. Follow them. If the
code contradicts this document, trust the code and fix the description here.

The source is TypeScript and comment-free by design (hexagonal architecture) — this
document is the single source of truth for the "why" behind non-obvious decisions.
When you learn something surprising about the code, add it here instead of a code
comment.

> The design that produced this layout is recorded in
> [docs/superpowers/specs/2026-07-02-typescript-hexagonal-migration-design.md](docs/superpowers/specs/2026-07-02-typescript-hexagonal-migration-design.md),
> which supersedes the earlier
> [docs/superpowers/specs/2026-07-02-clean-architecture-refactor-design.md](docs/superpowers/specs/2026-07-02-clean-architecture-refactor-design.md).

## What it does (one sentence)

The agent pulls **unprocessed emails** from a mailbox (IMAP, Seznam), classifies
**invoice-like attachments** with Mistral, and uploads the ones that qualify to
**TRIVI "uploaded documents"**. It runs as an **AWS Lambda** (cron via EventBridge);
locally via `docker-compose` or `tsx watch`.

> This is **not** full invoice issuing — only attachment upload into TRIVI's
> "uploaded documents" inbox for manual/automatic accounting there.

## Architecture & data flow

Entry point: `handler` in [src/handler.ts](src/handler.ts).

```
handler (Lambda)                             # Sentry.wrapHandler (init only if SENTRY_DSN set)
  └─ setup()                                  # warm-start: services cached across invocations (module-level `services`)
       loadConfig()                           # SECRET_NAME set → Secrets Manager; else .env — assertConfig() on BOTH
       builds concrete adapters               # TriviAuth/TriviUploadAdapter, ImapEmailAdapter, S3StorageAdapter,
                                                # SnsNotificationAdapter, MistralClassifierAdapter (or null if no API key)
  └─ processInvoices(svc)                     # src/application/process-invoices.ts
       email.connect()                        # ONE persistent IMAP connection; ensures target folders once
       1. email.fetchUnprocessedEmails()      # everything in INBOX = unprocessed
       2. for each email → processEmail(msg, svc)  # per-email, never throws (isolation)
            filter isInvoiceAttachment()      # by extension OR MIME type
            for each qualifying attachment:
              classifier.classifyAttachment() # Mistral: is it an accounting doc? (skip if disabled)
              trivi.uploadDocumentAttachment() # two-step upload→scan; each step retried internally (idempotent)
            storage.archiveEmail()            # S3, best-effort (warn-only on failure)
            email.markAsProcessed/markAsSkipped() # move email out of INBOX → "TRIVI" or "Bez dokladu" folder
            cleanup temp attachments
       3. sendSummary()                       # src/application/summary.ts — SNS summary (Czech) + escalate failures to admin
       email.disconnect()                     # in finally — always runs
  emitMetrics()                               # CloudWatch EMF: processed/successful/skipped/failed
```

The layout is hexagonal: `domain` and `application` know nothing about IMAP, TRIVI,
Mistral, or AWS — they only see the `ports` interfaces. `handler.ts` is the
composition root that wires concrete `adapters` into those ports.

| Layer | Description | Key file(s) |
|---|---|---|
| `domain/` | Pure types and business rules — no I/O, no SDKs | [types.ts](src/domain/types.ts) (domain model), [attachment-filter.ts](src/domain/attachment-filter.ts) (`isInvoiceAttachment`), [payment.ts](src/domain/payment.ts) (`paymentTypeFromMethod`/`PAYMENT_TYPE_CODES`), [classification.ts](src/domain/classification.ts) (`parseClassification`/`guessMimeType`) |
| `ports/` | Interfaces the application depends on, implemented by adapters | [email-port.ts](src/ports/email-port.ts), [trivi-port.ts](src/ports/trivi-port.ts), [classifier-port.ts](src/ports/classifier-port.ts), [storage-port.ts](src/ports/storage-port.ts), [notification-port.ts](src/ports/notification-port.ts), [services.ts](src/ports/services.ts) (`Services` bag) |
| `application/` | Orchestration — depends only on ports | [process-invoices.ts](src/application/process-invoices.ts) (`processInvoices`, `processEmail`), [summary.ts](src/application/summary.ts) (`sendSummary`) |
| `adapters/email/` | IMAP implementation of `EmailPort` + attachment materialization | [imap-adapter.ts](src/adapters/email/imap-adapter.ts) (`ImapEmailAdapter` — one persistent connection, fetch/parse/move), [materialize.ts](src/adapters/email/materialize.ts) (zip expansion, PNG conversion, byte-envelope normalization, MIME inference) |
| `adapters/trivi/` | TRIVI implementation of `TriviPort` | [auth.ts](src/adapters/trivi/auth.ts) (`TriviAuth` — bearer token cache/refresh, 5 min buffer), [upload-adapter.ts](src/adapters/trivi/upload-adapter.ts) (`TriviUploadAdapter.uploadDocumentAttachment` — two-step upload, each step retried internally) |
| `adapters/mistral/` | Mistral implementation of `ClassifierPort` | [classifier-adapter.ts](src/adapters/mistral/classifier-adapter.ts) (`MistralClassifierAdapter` — accounting-document classification) |
| `adapters/aws/` | AWS implementations of `StoragePort`/`NotificationPort` + secrets loading | [s3-storage.ts](src/adapters/aws/s3-storage.ts) (`S3StorageAdapter`), [sns-notification.ts](src/adapters/aws/sns-notification.ts) (`SnsNotificationAdapter`), [secrets.ts](src/adapters/aws/secrets.ts) (Secrets Manager loader) |
| `shared/` | Cross-cutting utilities, no domain knowledge | [retry.ts](src/shared/retry.ts) (`withRetry`/`defaultShouldRetry`), [image.ts](src/shared/image.ts) (`needsPngConversion`/`toPng`/`toPngFilename`), [logger.ts](src/shared/logger.ts) (`log.info/warn/error`), [metrics.ts](src/shared/metrics.ts) (`emitMetrics`) |
| `config.ts` + `handler.ts` | Composition root | [config.ts](src/config.ts) (`loadConfig`/`assertConfig`), [handler.ts](src/handler.ts) (Lambda entry, Sentry-wrapped, builds and wires adapters) |

**Ports.** Five port interfaces define the boundary between `application` and the
outside world: `EmailPort`, `TriviPort`, `ClassifierPort`, `StoragePort`,
`NotificationPort` (all in [src/ports/](src/ports)). `application/` and `domain/`
depend only on these interfaces — never on a concrete adapter or an SDK import.
`handler.ts` is the only place that imports concrete adapters and wires them into a
`Services` object (`src/ports/services.ts`) passed down to `processInvoices`.

Infra: [terraform/](terraform/) (ECR, EventBridge, IAM, Lambda, S3, Secrets, SNS),
[Dockerfile](Dockerfile) (AWS Lambda nodejs:22 base), [docker-compose.yml](docker-compose.yml) (local run).

## Domain knowledge (the why)

These are decisions that aren't obvious from reading the code in isolation. Keep
this section current — it's the only place they're written down.

1. **The 6 invariants — do not break these:**
   1. **An email is marked processed (moved out of INBOX) ONLY after a successful
      upload.** `result.success` gates `markAsProcessed` in
      [src/application/process-invoices.ts](src/application/process-invoices.ts).
      Never mark an email processed before it is uploaded to TRIVI.
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
   [src/adapters/email/materialize.ts](src/adapters/email/materialize.ts) strips
   any leading bytes before the expected magic marker for `.pdf`/`.xml`/`.isdoc`,
   for both zip entries and direct attachments.

4. **TRIVI payment-type enum.** `uploadDocumentAttachment` maps the classifier's
   `paymentMethod` string to TRIVI's numeric `paymentType` via
   `paymentTypeFromMethod`/`PAYMENT_TYPE_CODES` in
   [src/domain/payment.ts](src/domain/payment.ts):
   `bank_transfer=1, cash=2, cod=3, card=4`. `unknown`/missing omits the field
   entirely rather than guessing.

5. **Mistral cost-routing.** `MistralClassifierAdapter.classifyAttachment` in
   [src/adapters/mistral/classifier-adapter.ts](src/adapters/mistral/classifier-adapter.ts)
   routes by MIME type to keep cost down: images (`png`/`jpeg`/`webp` — HEIC/HEIF
   are converted to JPEG first) go straight to the vision chat model; everything
   else (PDFs) goes through Mistral OCR first and the extracted text is then
   classified by the same cheap chat model. Only one LLM call per attachment
   either way.

6. **Zip safeguards.** [src/adapters/email/materialize.ts](src/adapters/email/materialize.ts)
   caps zip expansion at `MAX_ZIP_ENTRIES = 50` entries and
   `MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024` uncompressed bytes (checked against
   the zip header's declared size *before* decompressing, so a size-lie in the
   header can't be used to force a full decompress). Entry names are resolved with
   `path.basename` and rejected if empty/`.`/`..`, and the final write path is
   verified to stay inside `destDir` (zip-slip guard) before anything is written.

7. **HEIC/HEIF/WebP/TIFF → PNG.** TRIVI only reliably accepts PDF/JPEG/PNG.
   `needsPngConversion` in [src/shared/image.ts](src/shared/image.ts) flags
   `.heic/.heif/.webp/.tif/.tiff` (by extension or MIME) for conversion:
   HEIC/HEIF go through `heic-convert`, everything else through `sharp`. This
   happens once, in `materializeAttachments`, before classification or upload —
   so both the classifier and TRIVI only ever see a TRIVI-safe PNG.

8. **Retry granularity — the two-step upload is non-idempotent.** The TRIVI upload
   is `POST /uploads` (uploads the file, returns `fileId`) → `POST
   /accountingdocuments/scans` (creates the doc). Retrying the WHOLE operation
   after step 1 succeeds would re-upload the file (orphan + duplicate). So retry
   lives INSIDE [src/adapters/trivi/upload-adapter.ts](src/adapters/trivi/upload-adapter.ts):
   each step is wrapped in its own `withRetry` and a step-2 failure retries only
   step 2, reusing the same `fileId`. Do NOT re-add an outer `withRetry` around
   `uploadDocumentAttachment`. The FormData/read stream is rebuilt inside each
   step-1 attempt (a consumed stream can't be re-read).

9. **Retry only opens for transient errors.** `defaultShouldRetry` in
   [src/shared/retry.ts](src/shared/retry.ts) retries network errors (no
   `response`), 5xx, and 429; it does NOT retry other 4xx (400/401/403/…), which
   are permanent and would only burn attempts + backoff.

10. **Sentry is opt-in.** [src/handler.ts](src/handler.ts) calls `Sentry.init`
    ONLY when `SENTRY_DSN` is set (else a full no-op) and wraps the handler with
    `Sentry.wrapHandler` so rethrown fatal errors are captured before the Lambda
    DLQ. Keep the guard — no DSN must mean no network calls (local/tests).

11. **EMF metrics, not an SDK call.** [src/shared/metrics.ts](src/shared/metrics.ts)
    writes one CloudWatch Embedded-Metric-Format JSON line to stdout;
    CloudWatch auto-extracts `EmailsProcessed/UploadsSuccessful/EmailsSkipped/
    UploadsFailed` from it. No PutMetricData permission needed. This is the only
    thing you can build alarms on — keep it emitting on every invocation.

## Configuration

- `SECRET_NAME` set → everything from AWS Secrets Manager (JSON with the same shape as
  `loadFromEnv`).
- `SECRET_NAME` empty → from env vars (`.env`). See [.env.example](.env.example).
- Required env (else `requireEnv` throws): `EMAIL_HOST/PORT/USER/PASSWORD`,
  `TRIVI_APP_ID/TRIVI_APP_SECRET`.
- `MISTRAL_API_KEY` is optional but strongly recommended: if unset, classification
  is disabled and **every** invoice-like attachment is uploaded unfiltered.

### Deployment (AWS)

- In prod, set `SECRET_NAME` — config then loads from AWS Secrets Manager instead
  of env vars (see `loadConfig` in [src/config.ts](src/config.ts)).
- The Lambda execution role needs: Secrets Manager `GetSecretValue`, SNS `Publish`
  (if `SNS_TOPIC_ARN` is used), and S3 `PutObject` (if `S3_BUCKET` is used).
- Dry-run one invocation in staging before enabling the production EventBridge
  schedule.

## Commands

```bash
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit — must be 0 errors
npm test           # node --import tsx --test over src/**/*.test.ts
npm start          # node dist/handler.js
npm run dev        # tsx watch src/handler.ts
docker compose up --build   # local run without AWS (see docker-compose.yml)
```

## Conventions

- The source is TypeScript (`strict`, NodeNext module/moduleResolution — see
  [tsconfig.json](tsconfig.json)) and comment-free — **no `//` or `/* */` comments
  anywhere**; types replace JSDoc for documenting shapes. Domain "why" belongs in
  this file, not in code comments.
- Relative imports MUST end in `.js` (e.g. `import { log } from
  '../shared/logger.js'`) even though the source file is `.ts` — this is a NodeNext
  ESM requirement, not a typo.
- Tests are `*.test.ts`, run via `tsx` under Node's built-in test runner
  (`node:test`) — no Jest/Vitest.
- Logs are prefixed with `[area]` (`[trivi]`, `[trivi-auth]`, `[email]`, `[retry]`,
  `[classify]`, `[storage]`, `[notification]`, `[setup]`). The Lambda entry point
  uses the structured JSON logger [src/shared/logger.ts](src/shared/logger.ts)
  (`log.info('lambda', …)`); adopt it for new areas incrementally — CloudWatch
  Logs Insights can then filter on fields instead of grepping strings.
- User-facing text (daily summary, alerts) is **in Czech**; internal logs are in English.
- One class/concern per file, grouped by hexagonal layer folder (`domain/`,
  `ports/`, `application/`, `adapters/{email,trivi,mistral,aws}/`, `shared/`). Add
  new integrations as their own file under the relevant `adapters/` subfolder.

## Security — important

- `.env` is in `.gitignore` — keep it that way. [.env.example](.env.example) holds
  placeholders only; never replace them with real credentials.
- In prod, secrets belong in Secrets Manager, not in env files.

## How to work in this repo (agents & skills)

- **Diagnosing a failed run** → agent `pipeline-triage` (`.claude/agents/`).
- **Mapping an issue/feature to code, and architecture** → agent `system-architect`.
- **Before committing** → skill `pre-commit-review` (secrets, invariants above).
- **Verifying a local run** → skill `local-smoke-test`.

Workflow: understand first (system-architect / read the relevant layer), then change,
then verify (local-smoke-test), then review (pre-commit-review). On a bug, start with
triage, not guesses.
