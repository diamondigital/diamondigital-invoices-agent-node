# TypeScript + Hexagonal Architecture Migration — Design

Date: 2026-07-02
Status: Approved (pending spec review)

## Goal

Rewrite the whole `src/` from JavaScript (+ JSDoc `checkJs`) to **TypeScript**, and
restructure the folders around the **hexagonal / ports-and-adapters** pattern so that
generic utilities, external-service integrations, and cloud infrastructure are no
longer siblings at the same level.

**Behavior does not change.** All 6 invariants in `AGENTS.md` are preserved. This is a
structural + type migration, not a logic change. Same tests, same runtime behavior,
same daily-cron Lambda.

## Why hexagonal (ports & adapters)

The app is a use-case (pull emails → classify → upload) wired to several external
systems (IMAP/Seznam, TRIVI HTTP, Mistral, AWS S3/SNS/Secrets). This is the exact
shape the pattern targets: isolate business logic from integration code behind
interfaces.

- AWS Prescriptive Guidance — Hexagonal architecture pattern:
  https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/hexagonal-architecture.html
- aws-samples/aws-lambda-hexagonal-architecture:
  https://github.com/aws-samples/aws-lambda-hexagonal-architecture

`application/` depends only on `domain/` + `ports/` (interfaces). `adapters/` implement
the ports. `handler.ts` is the single composition root that wires concrete adapters
into the use-case — a formalization of today's `setup()`.

## Target structure

```
src/
  domain/                    pure business rules — no I/O, no SDK imports
    types.ts                 Attachment, Classification, EmailMessage, ProcessResult, AppConfig, ...
    payment.ts               paymentTypeFromMethod, PAYMENT_TYPE_CODES
    attachment-filter.ts     isInvoiceAttachment
    classification.ts        parseClassification (+ pure parsing rules)
  ports/                     interfaces the use-case depends on
    email-port.ts            EmailPort
    trivi-port.ts            TriviPort
    classifier-port.ts       ClassifierPort
    storage-port.ts          StoragePort
    notification-port.ts     NotificationPort
    services.ts              Services (aggregate: cfg + the 5 ports, classifier optional)
  application/               use-cases; depends on domain + ports only
    process-invoices.ts      processInvoices + processEmail
    summary.ts               buildSummaryLines + sendSummary
  adapters/                  concrete implementations of ports (outside world)
    email/
      imap-adapter.ts        ImapEmailAdapter implements EmailPort
      materialize.ts         zip/png/byte-envelope normalization, MIME inference
    trivi/
      auth.ts                TriviAuth (token cache/refresh)
      upload-adapter.ts      TriviUploadAdapter implements TriviPort (uses domain/payment)
    mistral/
      classifier-adapter.ts  MistralClassifierAdapter implements ClassifierPort
    aws/
      s3-storage.ts          S3StorageAdapter implements StoragePort
      sns-notification.ts    SnsNotificationAdapter implements NotificationPort
      secrets.ts             loadFromSecretsManager
  shared/                    generic, domain-agnostic utilities
    retry.ts                 withRetry, defaultShouldRetry
    image.ts                 needsPngConversion, toPng, toPngFilename
    logger.ts                structured JSON logger
    metrics.ts               CloudWatch EMF metrics
  config.ts                  loadConfig + assertConfig (composition-time)
  handler.ts                 composition root + Lambda entry (Sentry-wrapped)
```

Dependency direction (inward only): `adapters → ports/domain`, `application → ports/domain`,
`shared` depends on nothing app-specific, `handler/config` may touch anything (composition root).

## File mapping (old → new)

| Old (`.js`) | New (`.ts`) | Notes |
|---|---|---|
| `handler.js` | `handler.ts` | composition root; build `Services` from adapters |
| `config.js` | `config.ts` | + secrets loader moves to `adapters/aws/secrets.ts` |
| `types.js` | `domain/types.ts` | JSDoc typedefs → real `interface`/`type` |
| `trivi/mapping.js` | `domain/payment.ts` | pure |
| `pipeline/attachment-filter.js` | `domain/attachment-filter.ts` | pure |
| `classify/classifier.js` (parseClassification) | `domain/classification.ts` | pure part only |
| `classify/classifier.js` (DocumentClassifier) | `adapters/mistral/classifier-adapter.ts` | implements ClassifierPort |
| `pipeline/run.js` | `application/process-invoices.ts` | processInvoices + processEmail |
| `pipeline/summary.js` | `application/summary.ts` | |
| `email/client.js` | `adapters/email/imap-adapter.ts` | implements EmailPort |
| `email/materialize.js` | `adapters/email/materialize.ts` | |
| `trivi/auth.js` | `adapters/trivi/auth.ts` | |
| `trivi/upload.js` | `adapters/trivi/upload-adapter.ts` | implements TriviPort |
| `aws/storage.js` | `adapters/aws/s3-storage.ts` | implements StoragePort |
| `aws/notifications.js` | `adapters/aws/sns-notification.ts` | implements NotificationPort |
| `lib/retry.js` | `shared/retry.ts` | |
| `lib/image.js` | `shared/image.ts` | |
| `lib/logger.js` | `shared/logger.ts` | |
| `lib/metrics.js` | `shared/metrics.ts` | |

Every `*.test.js` moves next to its new module as `*.test.ts`. The classifier test
splits: pure `parseClassification` → `domain/classification.test.ts`, the adapter →
`adapters/mistral/classifier-adapter.test.ts`.

## Ports (interfaces)

Derived from how `application/process-invoices.ts` uses the collaborators today:

- `EmailPort`: `connect()`, `disconnect()`, `fetchUnprocessedEmails(): Promise<EmailMessage[]>`,
  `markAsProcessed(id)`, `markAsSkipped(id)`
- `TriviPort`: `uploadDocumentAttachment(attachment, metadata): Promise<UploadResult>`
- `ClassifierPort`: `classifyAttachment(attachment, context): Promise<Classification>`
- `StoragePort`: `archiveEmail(emailId, content): Promise<void>`
- `NotificationPort`: `sendSummary(message)`, `sendAlert(subject, body)`
- `Services`: `{ cfg: AppConfig; email: EmailPort; trivi: TriviPort; classifier: ClassifierPort | null; storage: StoragePort; notification: NotificationPort }`

`classifier` stays nullable (invariant: no Mistral key → classification disabled).

## Build & tooling

- **Compiler:** `tsc → dist/`. Chosen over esbuild because `sharp` and `heic-convert`
  (libheif) are native modules esbuild can't bundle; `tsc` + full prod `node_modules`
  ships them without externalization gymnastics. Cold start is irrelevant for a
  once-daily cron. `tsc` compile IS the type gate.
- **Strictness:** `strict: true` (+ `noUncheckedIndexedAccess`, `noImplicitOverride`).
  No `any`, no `@ts-ignore`. Dynamic SDK responses are typed at the adapter boundary.
- **Module:** `module: nodenext`, `moduleResolution: nodenext`, `target: es2023`,
  ESM stays. Relative imports in source use the `.js` extension (NodeNext requirement).
- **tsconfig.json:** `rootDir: src`, `outDir: dist`, `declaration: false`,
  `sourceMap: true`, `skipLibCheck: true`.
- **Tests:** stay on `node:test`, run via `tsx` for fast iteration without a build step:
  `node --import tsx --test "src/**/*.test.ts"`. No Jest/Vitest.
- **Scripts:** `build` = `tsc`; `typecheck` = `tsc --noEmit`; `test` = tsx runner above;
  `start` = `node dist/handler.js`; `dev` = `tsx watch src/handler.ts`.
- **Types packages:** add `@types/adm-zip` and any missing (`heic-convert` etc.); for
  libraries shipping their own types (axios, aws-sdk v3, form-data, imapflow, mailparser,
  sharp) none needed. Where a lib has no types, add a minimal `src/types/<lib>.d.ts`
  declaration rather than `any`.
- **Dockerfile:** multi-stage — builder installs all deps + `npm run build`; runtime
  image copies `dist/` + `npm ci --production` node_modules. `CMD ["dist/handler.handler"]`.
- **docker-compose.yml:** update the `node -e` import path to `./dist/handler.js`.
- **.dockerignore:** ensure `src` tests / dev files don't bloat the runtime stage
  (build stage needs `src`; runtime stage only needs `dist` + prod deps).
- **CI (.github):** update to run `npm run typecheck` + `npm test` on the TS sources.

## Cleanup (confirmed)

- **Delete `LOCAL_AWS_SWITCH_NOTE.md`** — stale, references paths the migration removes;
  content already in `AGENTS.md`. First fold its unique "Safe deployment checklist for
  AWS" (IAM perms: Secrets Manager GetSecretValue, SNS Publish, S3 PutObject) into
  `AGENTS.md`.
- **Delete `.superpowers/sdd/`** — 544 KB of local, un-gitted SDD run artifacts. Local
  only; does not touch git.
- **Rewrite `README.md`** — from a 1-line stub to a minimal real README: one-paragraph
  what-it-does, quickstart (`npm install`, `npm test`, `npm run build`, docker compose),
  and a pointer to `AGENTS.md` as the source of truth.
- **Keep `docs/superpowers/{plans,specs}`** as dated history; this spec joins them. Note
  in `AGENTS.md` that `2026-07-02-clean-architecture-refactor` is superseded by this.
- **Update `AGENTS.md`** — new structure, layer table, ports list, build commands, the
  `.js`-import-extension convention, and the folded AWS deploy checklist.

## Invariants preserved (must re-verify after migration)

1. Email marked processed only after a successful upload (`result.success` gates it).
2. Processed state = folder move (Seznam has no labels).
3. Per-email error isolation (`processEmail` never throws; only connect/fetch fatal).
4. No deduplication.
5. S3 archive + SNS best-effort.
6. TRIVI HTML-instead-of-JSON guard.
   Plus the recent additions: internal per-step upload retry (idempotent),
   `defaultShouldRetry` (no retry on 4xx), single IMAP connection, EMF metrics,
   Sentry guarded by `SENTRY_DSN`, `assertConfig` on both config paths.

## Non-goals

- No behavior/logic changes. No new features.
- Sequential processing stays sequential (deliberate — rate limits, isolation).
- No DI container (InversifyJS etc.) — the composition root in `handler.ts` is enough.
- No change to Terraform resources (only the Docker build stage changes).

## Risks & mitigations

- **Native deps (`sharp`, `heic-convert`):** keep as external node_modules; do not
  bundle. Runtime Docker stage installs prod deps for the Lambda platform.
- **NodeNext ESM `.js` extensions in TS imports:** enforced by tsconfig; easy to miss —
  the `tsc` build will catch missing/incorrect extensions.
- **Libraries without types:** add `@types/*` or a local `.d.ts`; never `any`.
- **Test runner on TS:** `tsx` import hook; verify `node --test` discovers `.test.ts`.
- **Big-bang risk:** execute in waves (domain/shared first → ports → adapters →
  application → handler/build), running the suite between waves, mirroring the previous
  refactor's approach.

## Testing

Every module keeps its test, migrated to `.test.ts`. Green gate after each wave:
`npm run typecheck` (0 errors) + `npm test` (all pass). Final: build the Docker image
and smoke-run via docker-compose to confirm the compiled `dist/handler.js` loads and
runs end-to-end with AWS disabled.
