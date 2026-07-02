# Clean-architecture refactor — diamondigital-invoices-agent-node

Date: 2026-07-02

## Goal

Make the codebase slim, comment-free, and self-explanatory: delete dead code,
reorganize into a domain-oriented folder structure, strip all comments (moving
essential "why" into AGENTS.md), and cover the essential paths with tests.
Behavior of the live upload pipeline must not change.

## Non-goals

- No behavior change to the email→TRIVI upload flow.
- No new features.
- No change to infrastructure topology (still container-image Lambda + EventBridge).

## Part 1 — Delete dead code

The pipeline (`handler` → `processInvoices`) only ever uploads attachments.
The invoice-creation lineage is dead relative to it. Delete:

- `src/finaccount-mapper.js` — never imported.
- In the TRIVI client, keep ONLY `uploadDocumentAttachment` and its private
  auth-header helper. Delete `createInvoice`, `getDocument`, `getDocumentIssues`,
  `findContactByExternalId`, `findContactByEmail`, `createContact`,
  `getOrCreateContact`, `getSequences`, `getVatRates`, `getBankAccounts`, the
  `#headers` helper, and the unused `bankAccountId` field.
- `bankAccountId` / `TRIVI_BANK_ACCOUNT_ID` config plumbing in `config.js`,
  `.env`, `.env.example`, `terraform/secrets.tf` example (only the bank-account
  field; leave real config intact).
- Stale AGENTS.md references: `src/invoice-extractor.js` (file does not exist),
  the "no tests exist yet" note, and the `.env.example` real-secret warning.

## Part 2 — Domain-oriented folder structure

```
src/
  handler.js              Lambda entry (thin: warm-start setup + delegate)
  config.js               config loading: Secrets Manager (prod) vs .env (local)
  pipeline/
    run.js                processInvoices orchestration (per-email isolation)
    attachment-filter.js  isInvoiceAttachment (by extension or MIME)
    summary.js            Czech daily summary formatting
  email/
    client.js             IMAP: fetch INBOX, move processed/skipped (was EmailService)
    materialize.js        attachments → temp files: zip expand + PNG convert + normalize + MIME
  trivi/
    auth.js               bearer token cache + auto-refresh (was TriviAuth)
    upload.js             uploadDocumentAttachment two-step flow (was TriviService)
  classify/
    classifier.js         Mistral document classifier
  aws/
    storage.js            S3 audit archive (best-effort)
    notifications.js      SNS summaries + alerts
  lib/
    image.js              needsPngConversion, toPng, toPngFilename
    retry.js              generic exponential-backoff wrapper
```

Mapping from current files:

| Current | New |
|---|---|
| `src/index.js` | split → `handler.js` + `pipeline/run.js` + `pipeline/attachment-filter.js` + `pipeline/summary.js` |
| `src/config.js` | `config.js` (unchanged location) |
| `src/email-service.js` | split → `email/client.js` (IMAP) + `email/materialize.js` (zip/convert/normalize/MIME) |
| `src/trivi-auth.js` | `trivi/auth.js` |
| `src/trivi-service.js` | `trivi/upload.js` (only `uploadDocumentAttachment`) |
| `src/document-classifier.js` | `classify/classifier.js` |
| `src/storage-service.js` | `aws/storage.js` |
| `src/notification-service.js` | `aws/notifications.js` |
| `src/image-conversion.js` | `lib/image.js` |
| `src/retry.js` | `lib/retry.js` |
| `src/finaccount-mapper.js` | deleted |

Exported names may stay the same (`EmailService`, `TriviService`→`TriviUploader`
or keep `TriviService`, etc.) — only import paths change. Keep class/function
names stable unless a rename improves clarity; note any rename in the plan.

## Part 3 — Style: zero comments, self-explanatory code

- Remove every comment: `//`, `/* */`, JSDoc blocks, and file-header comments.
- Logs are not comments — keep them, including the `[area]` prefix convention
  (`[email]`, `[trivi]`, `[retry]`, `[lambda]`).
- Where a comment compensated for unclear code, make the code self-explanatory
  instead: name the constant (e.g. `PAYMENT_TYPE_CODES`, magic-byte buffers,
  thresholds), extract a well-named helper, or rename a variable.
- User-facing text stays Czech; internal logs stay English.

Essential "why" migrates to **AGENTS.md** as the single source of truth,
rewritten to the new structure. Must capture: the six invariants (processed =
moved out of INBOX; mark-processed only after successful upload; per-email error
isolation; no dedup; S3/SNS optional best-effort; TRIVI HTML-response = wrong
endpoint), plus Seznam-has-no-labels, the java-serialization envelope stripping,
the TRIVI payment-type enum (1=BankTransfer 2=Cash 3=COD 4=Card), the Mistral
cost-routing (images→vision, PDFs→OCR), the zip safeguards (entry/byte caps,
zip-slip guard), and the TRIVI-unsupported-image→PNG rule.

## Part 4 — Test coverage for essential paths

Framework: Node built-in `node:test` only (no Jest/Vitest). Keep and relocate
the existing `email` and `image-conversion` tests next to their new modules.

New tests:

- `trivi/upload.test.js` — mock `axios`: two-step flow (uploads returns `{id}`,
  scans creates the document); HTML response (`<!doctype`) throws a clear error
  for both steps; missing file id throws; `paymentType` mapping from
  `classification.paymentMethod`.
- `lib/retry.test.js` — succeeds first try; recovers after a transient failure;
  throws after `maxAttempts`; respects attempt count.
- `config.test.js` — `SECRET_NAME` set → parses Secrets Manager JSON;
  `SECRET_NAME` empty → reads env; `requireEnv` throws on a missing required var.
- `pipeline/run.test.js` — with fake email/trivi/classifier/storage/notification
  collaborators: one email throwing does not abort the others; an email is
  marked processed ONLY after a successful upload; a no-accounting-document email
  is marked skipped; the confidence threshold gates upload; classifier-disabled
  path uploads invoice-like attachments.
- `pipeline/attachment-filter.test.js` — accepts by extension and by MIME;
  rejects non-invoice types.
- `pipeline/summary.test.js` — correct ok/skip/fail tallies and Czech summary
  lines; failures escalate to the admin alert.
- `classify/classifier.test.js` — the pure bits only: MIME guessing by
  extension and the JSON-parse fallback to a safe default. (Live Mistral calls
  are not exercised in unit tests.)

To make orchestration testable, `pipeline/run.js` exports `processInvoices(svc)`
taking its collaborators as an argument (dependency injection), and
`attachment-filter.js` / `summary.js` export their pure functions.

## Part 5 — Sequencing and infra impact

1. **Phase 0 — Prune:** delete dead code (Part 1); full suite green.
2. **Phase 1 — Restructure + strip + test, unit by unit:** move each concern to
   its new home, strip its comments/JSDoc, port or add its tests, and keep
   `npm test` green after each unit. Rewire imports and `handler.js`.
3. **Phase 2 — Docs + verify:** rewrite AGENTS.md to the new structure with the
   migrated "why"; run the full suite and a local smoke test; final review.

Infra/config touched by the `index.js → handler.js` rename and the reorg:

- `Dockerfile`: `CMD ["src/index.handler"]` → `CMD ["src/handler.handler"]`.
- `docker-compose.yml`: `import('./src/index.js')` → `import('./src/handler.js')`.
- `terraform/lambda.tf`: update the handler/image config if it names `index`.
- `package.json` scripts: `start`/`dev` point at `src/handler.js`; `test`
  becomes `node --test` (auto-discovers nested `*.test.js`) — verify discovery
  works with the new subfolders.
- `.claude/` agents/skills and README references that name old paths.

## Success criteria

- No file under `src/` contains a comment (`//`, `/* */`, JSDoc, header).
- `finaccount-mapper.js` and the unused TRIVI methods are gone; the TRIVI client
  exposes only the upload flow.
- `src/` follows the Part 2 structure; each file has one clear responsibility.
- `npm test` passes, covering every path listed in Part 4.
- A local smoke test processes at least one email end-to-end (or reports an empty
  INBOX cleanly) with no errors.
- AGENTS.md matches the new structure and carries the migrated "why"; no stale
  references remain.
