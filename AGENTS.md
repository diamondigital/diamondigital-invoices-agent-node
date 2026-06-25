# AGENTS.md — diamondigital-invoices-agent-node

Project rules for AI agents (and humans) working in this repo. Follow them. If the
code contradicts this document, trust the code and fix the description here.

## What it does (one sentence)

The agent pulls **unprocessed emails** from a mailbox (IMAP, Seznam), filters
**invoice-like attachments**, and uploads them to **TRIVI "uploaded documents"**.
It runs as an **AWS Lambda** (cron via EventBridge); locally via `docker-compose`
or `node --watch`.

> This is **not** full invoice issuing — only attachment upload.
> `src/invoice-extractor.js` (Mistral LLM) and `src/finaccount-mapper.js` are
> **legacy** from the original invoice-creation flow and are **not called** by the
> current upload flow. Leave them alone unless explicitly asked.

## Architecture & data flow

Entry point: `handler` in [src/index.js](src/index.js).

```
handler (Lambda)
  └─ setup()                         # warm-start: services cached across invocations (module-level `services`)
       loadConfig()                  # SECRET_NAME set → Secrets Manager; else .env
  └─ processInvoices(svc)
       1. email.fetchUnprocessedEmails()        # everything in INBOX = unprocessed
       2. for each email (isolated):
            filter isInvoiceAttachment()        # by extension OR MIME type
            trivi.uploadDocumentAttachment()    # wrapped in withRetry(3×, exp backoff)
            storage.archiveEmail()              # S3, best-effort (warn-only on failure)
            email.markAsProcessed()             # move email out of INBOX → "TRIVI" folder
            cleanup temp attachments
       3. sendSummary()                          # SNS summary + escalate failures to admin
```

Layers (one file = one responsibility):

| File | Responsibility |
|---|---|
| [src/index.js](src/index.js) | Lambda handler, pipeline orchestration, attachment filter, daily summary |
| [src/config.js](src/config.js) | Config loading: Secrets Manager (prod) vs `.env` (local) |
| [src/email-service.js](src/email-service.js) | IMAP: fetch INBOX, parse attachments to temp, move processed to folder |
| [src/trivi-auth.js](src/trivi-auth.js) | TRIVI bearer token (cache + auto-refresh, 5 min buffer) |
| [src/trivi-service.js](src/trivi-service.js) | TRIVI REST v2 client; key method: `uploadDocumentAttachment` |
| [src/storage-service.js](src/storage-service.js) | S3 audit archive (best-effort) |
| [src/notification-service.js](src/notification-service.js) | SNS summaries + alerts |
| [src/retry.js](src/retry.js) | Generic exponential-backoff wrapper |
| [src/invoice-extractor.js](src/invoice-extractor.js) | **Legacy** — Mistral extraction, unused |
| [src/finaccount-mapper.js](src/finaccount-mapper.js) | **Legacy** — finAccount mapping, unused |

Infra: [terraform/](terraform/) (ECR, EventBridge, IAM, Lambda, S3, Secrets, SNS),
[Dockerfile](Dockerfile) (AWS Lambda nodejs:22 base), [docker-compose.yml](docker-compose.yml) (local run).
Local ↔ AWS switching is documented in [LOCAL_AWS_SWITCH_NOTE.md](LOCAL_AWS_SWITCH_NOTE.md).

## Invariants — do not break these

1. **An email is marked processed (moved out of INBOX) ONLY after a successful upload.**
   `result.success` gates `markAsProcessed`. Never mark an email processed before it
   is uploaded to TRIVI.
2. **"Processed" state = email outside INBOX.** Seznam IMAP has no labels/keywords, so
   the marker is moving the message into a folder (default `TRIVI`, env
   `EMAIL_PROCESSED_LABEL`). Anything left in INBOX is reprocessed on the next run.
3. **Per-email error isolation.** One email failing must not abort the others — hence
   the try/catch inside the loop. Only an IMAP fetch failure is fatal (rethrow → DLQ).
4. **No deduplication.** If the upload succeeds but `markAsProcessed` fails, the email
   stays in INBOX and is **uploaded again next run → duplicate in TRIVI**. Keep this in
   mind whenever you touch the upload↔move ordering (see triage runbook).
5. **S3 archive and SNS are optional and best-effort** — an empty `S3_BUCKET` /
   `SNS_TOPIC_ARN` means "log only", not an error.
6. **A TRIVI upload returning HTML instead of JSON = wrong endpoint.**
   `uploadDocumentAttachment` detects this (`<!doctype`) and throws a clear error.
   Do not remove that guard.

## Configuration

- `SECRET_NAME` set → everything from AWS Secrets Manager (JSON with the same shape as
  `loadFromEnv`).
- `SECRET_NAME` empty → from env vars (`.env`). See [.env.example](.env.example).
- Required env (else `requireEnv` throws): `EMAIL_HOST/PORT/USER/PASSWORD`,
  `TRIVI_APP_ID/TRIVI_APP_SECRET`.

## Commands

```bash
npm start          # node src/index.js
npm run dev        # node --watch src/index.js --local
npm test           # node --test src/**/*.test.js  (NOTE: no tests exist yet)
docker compose up --build   # local run without AWS (see docker-compose.yml)
```

ESM project (`"type": "module"`) — use `import`, not `require`.
Node 22, built-in test runner only (`node:test`) — no Jest/Vitest.

## Security — important

- ⚠️ **[.env.example](.env.example) contains a real-looking `TRIVI_APP_SECRET` and other
  sensitive values.** These credentials should be **rotated** and replaced with
  placeholders (`***`) in the example file. Never commit real secrets.
- `.env` is in `.gitignore` — keep it that way.
- In prod, secrets belong in Secrets Manager, not in env files.

## Conventions

- Comments and logs: file header `// src/foo.js — description`. Logs are prefixed with
  `[area]` (`[trivi]`, `[email]`, `[retry]`, `[lambda]`). Keep this style.
- User-facing text (daily summary, alerts) is **in Czech**; internal logs are in English.
- One class/concern per file. Add new integrations as their own `*-service.js`.

## How to work in this repo (agents & skills)

- **Diagnosing a failed run** → agent `pipeline-triage` (`.claude/agents/`).
- **Mapping an issue/feature to code, and architecture** → agent `system-architect`.
- **Before committing** → skill `pre-commit-review` (secrets, invariants above).
- **Verifying a local run** → skill `local-smoke-test`.

Workflow: understand first (system-architect / read the relevant layer), then change,
then verify (local-smoke-test), then review (pre-commit-review). On a bug, start with
triage, not guesses.
