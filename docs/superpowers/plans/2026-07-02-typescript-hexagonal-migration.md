# TypeScript + Hexagonal Architecture Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `src/` from JavaScript (+JSDoc) to strict TypeScript and restructure into a hexagonal (ports & adapters) layout, with zero behavior change.

**Architecture:** `domain/` (pure rules) ← `application/` (use-cases) depend on `ports/` (interfaces); `adapters/` implement the ports; `shared/` holds generic utilities; `handler.ts` is the composition root that wires concrete adapters into the use-case. Build with `tsc → dist/`; run tests with `tsx` on `node:test`.

**Tech Stack:** Node 22, TypeScript (strict, NodeNext ESM), `tsx`, `node:test`, AWS SDK v3, axios, imapflow, mailparser, adm-zip, sharp, heic-convert, @mistralai/mistralai, @sentry/aws-serverless.

## Global Constraints

- **No behavior change.** All 6 invariants in `AGENTS.md` preserved; plus the recent additions (per-step idempotent upload retry, `defaultShouldRetry` no-retry-on-4xx, single IMAP connection, EMF metrics, Sentry guarded by `SENTRY_DSN`, `assertConfig` on both config paths).
- **No comments** anywhere except JSDoc is unnecessary now (real TS types replace it). Zero `//` and `/* */`. Source stays comment-free.
- **`strict: true`** + `noUncheckedIndexedAccess` + `noImplicitOverride`. No `any`, no `@ts-ignore`, no `@ts-nocheck`. Type dynamic SDK responses at the adapter boundary.
- **ESM NodeNext:** every relative import in `.ts` source MUST end with `.js` (e.g. `import { withRetry } from '../shared/retry.js'`). This is required — `tsc` resolves it to the emitted `.js`.
- **Each converted file:** `git rm` the old `.js` and its `.test.js`; create the new `.ts` and `.test.ts` at the new path. No `.js` may remain under `src/` at the end.
- **Per-task verify:** `node --import tsx --test "<new test path>"` green, and (from the layer boundary onward) `npm run typecheck` clean for converted files.
- **Node test runner only** (`node:test`) — no Jest/Vitest.
- Preserve all `[area]` log prefixes and Czech user-facing strings.

---

### Task 1: TypeScript toolchain

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `.dockerignore`

**Interfaces:**
- Produces: `npm run build` (tsc→dist), `npm run typecheck` (tsc --noEmit), `npm test` (tsx + node:test over `src/**/*.test.ts`), `npm start` (dist), `npm run dev` (tsx watch).

- [ ] **Step 1: Add devDependencies and scripts to `package.json`**

Add to `devDependencies`: `"typescript": "^5.6.0"`, `"tsx": "^4.19.0"`, `"@types/adm-zip": "^0.5.5"`, `"@types/heic-convert": "^2.1.0"`. Keep `@types/node`.
Replace `scripts` with:

```json
"scripts": {
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "test": "node --import tsx --test \"src/**/*.test.ts\"",
  "start": "node dist/handler.js",
  "dev": "tsx watch src/handler.ts"
}
```

- [ ] **Step 2: Overwrite `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "declaration": false,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
dist
.git
.superpowers
docs
terraform/.terraform
*.log
.env
```

- [ ] **Step 4: Install**

Run: `npm install`
Expected: adds typescript, tsx, @types/adm-zip, @types/heic-convert; lockfile updated.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .dockerignore
git commit -m "build: TypeScript toolchain (tsc->dist, tsx tests, strict)"
```

---

### Task 2: `domain/` layer

**Files:**
- Create: `src/domain/types.ts` (from `src/types.js`)
- Create: `src/domain/payment.ts` + `src/domain/payment.test.ts` (from `src/trivi/mapping.js` + test)
- Create: `src/domain/attachment-filter.ts` + `.test.ts` (from `src/pipeline/attachment-filter.js` + test)
- Create: `src/domain/classification.ts` + `.test.ts` (the pure `parseClassification` + `guessMimeType` split out of `src/classify/classifier.js` + the relevant tests from `src/classify/classifier.test.js`)
- Delete: `src/types.js`, `src/trivi/mapping.js`, `src/trivi/mapping.test.js`, `src/pipeline/attachment-filter.js`, `src/pipeline/attachment-filter.test.js`

**Interfaces:**
- Produces:
  - `types.ts`: `Attachment`, `Classification`, `ClassificationResult`, `EmailMessage`, `ProcessResult`, `UploadMetadata`, `UploadResult`, `PaymentMethod`, `EmailConfig`, `TriviConfig`, `MistralConfig`, `NotificationConfig`, `S3Config`, `AppConfig`.
  - `payment.ts`: `PAYMENT_TYPE_CODES`, `paymentTypeFromMethod(method: string | undefined | null): number | undefined`
  - `attachment-filter.ts`: `isInvoiceAttachment(attachment: Pick<Attachment,'filename'|'mimeType'>): boolean`, `INVOICE_ATTACHMENT_EXTENSIONS`, `INVOICE_ATTACHMENT_MIME_TYPES`
  - `classification.ts`: `parseClassification(raw: unknown): Classification`, `guessMimeType(filename: string, fallback?: string): string`

- [ ] **Step 1: Write `src/domain/types.ts`**

Convert the JSDoc typedefs in `src/types.js` to real TS. Full content:

```ts
export interface Attachment {
  filename: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
}

export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'cod' | 'unknown';

export interface Classification {
  isAccountingDocument: boolean;
  confidence: number;
  docType: string;
  paymentMethod: PaymentMethod;
  reason: string;
}

export interface ClassificationResult {
  filename: string;
  isAccountingDocument: boolean;
  confidence: number;
  docType: string;
  paymentMethod?: PaymentMethod;
  reason: string;
  uploaded: boolean;
}

export interface EmailMessage {
  emailId: string;
  subject: string;
  from: string;
  receivedDate: Date;
  bodyText: string;
  bodyHtml?: string;
  attachments: Attachment[];
}

export interface ProcessResult {
  emailId: string;
  subject: string;
  success: boolean;
  classifications?: ClassificationResult[];
  uploadedCount?: number;
  uploadedNames?: string[];
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}

export interface UploadMetadata {
  subject?: string;
  from?: string;
  receivedDate?: string;
  classification?: Partial<Classification>;
}

export interface UploadResult {
  fileId: string | number;
  scan: unknown;
}

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  processedLabel: string;
  skippedFolder: string;
}

export interface TriviConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  uploadsPath: string;
  scansPath: string;
  uploadFieldName: string;
}

export interface MistralConfig {
  apiKey: string;
  classifierModel: string;
  uploadThreshold: number;
}

export interface NotificationConfig {
  snsTopicArn: string;
  adminEmail: string;
}

export interface S3Config {
  bucketName: string;
}

export interface AppConfig {
  email: EmailConfig;
  trivi: TriviConfig;
  mistral: MistralConfig;
  notification: NotificationConfig;
  s3: S3Config;
}
```

- [ ] **Step 2: Convert `payment.ts` + test**

`git mv src/trivi/mapping.js src/domain/payment.ts` then rewrite with types (logic identical to the current file):

```ts
export const PAYMENT_TYPE_CODES: Record<string, number> = {
  bank_transfer: 1,
  cash: 2,
  cod: 3,
  card: 4,
};

export function paymentTypeFromMethod(method: string | undefined | null): number | undefined {
  if (!method) return undefined;
  return PAYMENT_TYPE_CODES[method];
}
```

`git mv src/trivi/mapping.test.js src/domain/payment.test.ts`; change the import to `./payment.js`; convert to TS (the assertions are unchanged). Run: `node --import tsx --test src/domain/payment.test.ts` → PASS.

- [ ] **Step 3: Convert `attachment-filter.ts` + test**

`git mv src/pipeline/attachment-filter.js src/domain/attachment-filter.ts`. Keep logic; add types:

```ts
import type { Attachment } from './types.js';

export const INVOICE_ATTACHMENT_EXTENSIONS = new Set<string>([
  '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.xml', '.isdoc', '.tif', '.tiff',
]);

export const INVOICE_ATTACHMENT_MIME_TYPES = new Set<string>([
  'application/pdf', 'application/xml', 'text/xml', 'image/jpeg', 'image/png',
  'image/webp', 'image/heic', 'image/heif', 'image/tiff',
]);

export function isInvoiceAttachment(attachment: Pick<Attachment, 'filename' | 'mimeType'>): boolean {
  const name = (attachment.filename || '').toLowerCase();
  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex >= 0 ? name.slice(dotIndex) : '';
  const mimeType = (attachment.mimeType || '').toLowerCase();
  return INVOICE_ATTACHMENT_EXTENSIONS.has(extension) || INVOICE_ATTACHMENT_MIME_TYPES.has(mimeType);
}
```

`git mv src/pipeline/attachment-filter.test.js src/domain/attachment-filter.test.ts`; fix import to `./attachment-filter.js`; run it → PASS.

- [ ] **Step 4: Create `classification.ts` (pure part of the classifier) + test**

Extract `parseClassification` and `guessMimeType` from `src/classify/classifier.js` into `src/domain/classification.ts`:

```ts
import type { Classification, PaymentMethod } from './types.js';

export function guessMimeType(filename: string, fallback?: string): string {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.heic': return 'image/heic';
    case '.heif': return 'image/heif';
    case '.tif':
    case '.tiff': return 'image/tiff';
    default: return fallback || 'application/octet-stream';
  }
}

export function parseClassification(raw: unknown): Classification {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        isAccountingDocument: Boolean(parsed.isAccountingDocument),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
        docType: (parsed.docType as string) || 'other',
        paymentMethod: ((parsed.paymentMethod as PaymentMethod) || 'unknown'),
        reason: (parsed.reason as string) || '',
      };
    } catch {
      // fallthrough
    }
  }
  return { isAccountingDocument: false, confidence: 0, docType: 'other', paymentMethod: 'unknown', reason: 'classification_unavailable' };
}
```

Note: the empty catch has no statement — remove the comment; use an empty block `{ }`. Create `src/domain/classification.test.ts` porting the `parseClassification`/`guessMimeType` assertions from `src/classify/classifier.test.js` (import from `./classification.js`). Run → PASS.

- [ ] **Step 5: Typecheck the domain layer**

Run: `npm run typecheck`
Expected: 0 errors (only `.ts` under src are checked; remaining `.js` are ignored by `allowJs:false`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(domain): types, payment, attachment-filter, classification in TS"
```

---

### Task 3: `shared/` layer

**Files:**
- Create: `src/shared/retry.ts` + `.test.ts` (from `src/lib/retry.js` + test)
- Create: `src/shared/image.ts` + `.test.ts` (from `src/lib/image.js` + test)
- Create: `src/shared/logger.ts` + `.test.ts` (from `src/lib/logger.js` + test)
- Create: `src/shared/metrics.ts` + `.test.ts` (from `src/lib/metrics.js` + test)
- Delete: the four `src/lib/*.js` + their `.test.js`

**Interfaces:**
- Produces:
  - `retry.ts`: `withRetry<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts?: RetryOptions): (...args: A) => Promise<R>`, `defaultShouldRetry(error: unknown): boolean`, `interface RetryOptions { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; shouldRetry?: (error: unknown, attempt: number) => boolean }`
  - `image.ts`: `needsPngConversion(filename: string, mimeType?: string): boolean`, `toPng(buffer: Buffer, ext: string, mimeType?: string): Promise<Buffer>`, `toPngFilename(filename: string): string`
  - `logger.ts`: `log: { info; warn; error }` each `(area: string, message: string, fields?: Record<string, unknown>) => void`
  - `metrics.ts`: `emitMetrics(counts: MetricCounts, now?: number): EmfPayload`, `interface MetricCounts { processed: number; successful: number; skipped: number; failed: number }`

- [ ] **Step 1: `retry.ts`**

`git mv src/lib/retry.js src/shared/retry.ts`. Keep logic identical. Add `RetryOptions` interface and types. For `withRetry`, type the generic so the wrapped function keeps its signature:

```ts
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export function defaultShouldRetry(error: unknown): boolean {
  if (!error) return true;
  const status = (error as { response?: { status?: number } }).response?.status;
  if (status === undefined) return true;
  if (status >= 500) return true;
  if (status === 429) return true;
  return false;
}

export function withRetry<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: RetryOptions = {},
): (...args: A) => Promise<R> {
  const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30000, shouldRetry = defaultShouldRetry } = opts;
  return async function (this: unknown, ...args: A): Promise<R> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn.apply(this, args);
      } catch (error) {
        lastError = error;
        if (!shouldRetry(error, attempt)) {
          console.error(`[retry] Non-retryable error, not retrying: ${(error as Error).message}`);
          throw error;
        }
        if (attempt < maxAttempts) {
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
          console.warn(`[retry] Attempt ${attempt}/${maxAttempts} failed: ${(error as Error).message}. Retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    console.error(`[retry] FAILED after ${maxAttempts} attempts: ${(lastError as Error).message}`);
    throw lastError;
  };
}
```

`git mv src/lib/retry.test.js src/shared/retry.test.ts`; fix import to `./retry.js`; convert error mocks to satisfy TS (use `Object.assign(new Error('x'), { response: { status: 500 } })`). Run → PASS.

- [ ] **Step 2: `image.ts`**

`git mv src/lib/image.js src/shared/image.ts`. Add types (`convertHeic` and `sharp` bring their own). Signatures per the Interfaces block. `git mv src/lib/image.test.js src/shared/image.test.ts`; fix import to `./image.js`; remove the trailing `// by MIME` comment. Run → PASS.

- [ ] **Step 3: `logger.ts`**

`git mv src/lib/logger.js src/shared/logger.ts`. Type `write(method: 'log'|'warn'|'error', level: string, area: string, message: string, fields: Record<string, unknown>)` and the three `log` methods `(area: string, message: string, fields?: Record<string, unknown>)`. `git mv src/lib/logger.test.js src/shared/logger.test.ts`; fix import to `./logger.js`; type the captured console output collection. Run → PASS.

- [ ] **Step 4: `metrics.ts`**

`git mv src/lib/metrics.js src/shared/metrics.ts`. Add `MetricCounts` interface and an `EmfPayload` type describing the returned object (`_aws` block + four numeric metric props). Keep `emitMetrics(counts, now = Date.now())`. `git mv src/lib/metrics.test.js src/shared/metrics.test.ts`; fix import to `./metrics.js`. Run → PASS.

- [ ] **Step 5: Typecheck + full run of shared tests**

Run: `npm run typecheck` → 0 errors.
Run: `node --import tsx --test "src/shared/*.test.ts"` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(shared): retry, image, logger, metrics in TS"
```

---

### Task 4: `ports/` layer (interfaces)

**Files:**
- Create: `src/ports/email-port.ts`, `src/ports/trivi-port.ts`, `src/ports/classifier-port.ts`, `src/ports/storage-port.ts`, `src/ports/notification-port.ts`, `src/ports/services.ts`

**Interfaces:**
- Produces the five port interfaces + `Services`, all consumed by `application/` (Task 9) and implemented by adapters (Tasks 5-8).

- [ ] **Step 1: Write the five port files + services**

`src/ports/email-port.ts`:
```ts
import type { EmailMessage } from '../domain/types.js';
export interface EmailPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  fetchUnprocessedEmails(): Promise<EmailMessage[]>;
  markAsProcessed(emailId: string): Promise<void>;
  markAsSkipped(emailId: string): Promise<void>;
}
```

`src/ports/trivi-port.ts`:
```ts
import type { Attachment, UploadMetadata, UploadResult } from '../domain/types.js';
export interface TriviPort {
  uploadDocumentAttachment(attachment: Attachment, metadata?: UploadMetadata): Promise<UploadResult>;
}
```

`src/ports/classifier-port.ts`:
```ts
import type { Attachment, Classification } from '../domain/types.js';
export interface ClassifyContext { subject?: string; from?: string }
export interface ClassifierPort {
  classifyAttachment(attachment: Attachment, context?: ClassifyContext): Promise<Classification>;
}
```

`src/ports/storage-port.ts`:
```ts
export interface StoragePort {
  archiveEmail(emailId: string, content: string): Promise<void>;
}
```

`src/ports/notification-port.ts`:
```ts
export interface NotificationPort {
  sendSummary(message: string): Promise<void>;
  sendAlert(subject: string, body: string): Promise<void>;
}
```

`src/ports/services.ts`:
```ts
import type { AppConfig } from '../domain/types.js';
import type { EmailPort } from './email-port.js';
import type { TriviPort } from './trivi-port.js';
import type { ClassifierPort } from './classifier-port.js';
import type { StoragePort } from './storage-port.js';
import type { NotificationPort } from './notification-port.js';
export interface Services {
  cfg: AppConfig;
  email: EmailPort;
  trivi: TriviPort;
  classifier: ClassifierPort | null;
  storage: StoragePort;
  notification: NotificationPort;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` → 0 errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(ports): define EmailPort, TriviPort, ClassifierPort, StoragePort, NotificationPort, Services"
```

---

### Task 5: `adapters/email/`

**Files:**
- Create: `src/adapters/email/materialize.ts` + `.test.ts` (from `src/email/materialize.js` + test)
- Create: `src/adapters/email/imap-adapter.ts` + `.test.ts` (from `src/email/client.js` + `src/email/client.test.js`)
- Delete: `src/email/materialize.js` (+test), `src/email/client.js` (+test)

**Interfaces:**
- Consumes: `shared/image.js` (`needsPngConversion`, `toPng`, `toPngFilename`), `domain/types.js`, `ports/email-port.js`.
- Produces: `class ImapEmailAdapter implements EmailPort`; `materializeAttachments(parsedAttachments, destDir): Promise<Attachment[]>`, plus the existing helpers (`isZipAttachment`, `extractZipEntries`).

- [ ] **Step 1: `materialize.ts`**

`git mv src/email/materialize.js src/adapters/email/materialize.ts`. Update the image import to `../../shared/image.js`. Add types: return type `Promise<Attachment[]>` for `materializeAttachments`; type `writeAttachmentRecord(...) : Promise<Attachment | null>`; type zip helpers. Parsed attachments from mailparser: type the param as `{ filename?: string; content: Buffer; contentType?: string }[]`. Keep all zip/png/byte-strip logic and the `DEFAULT_PROCESSED_LABEL` export identical.

- [ ] **Step 2: `materialize.test.ts`**

`git mv src/email/materialize.test.js src/adapters/email/materialize.test.ts`. Fix imports (`./materialize.js`). **Remove all `//` comments** (the security-rationale ones) — this is where they were flagged as remaining; they must go to satisfy the no-comments rule. Convert to TS (type the AdmZip fixtures). Run: `node --import tsx --test src/adapters/email/materialize.test.ts` → PASS.

- [ ] **Step 3: `imap-adapter.ts`**

`git mv src/email/client.js src/adapters/email/imap-adapter.ts`. Rename the class `EmailService` → `ImapEmailAdapter` and declare `implements EmailPort` (import from `../../ports/email-port.js`). Update the materialize import to `./materialize.js`. Keep the connect/disconnect/fetch/markAs* logic and the injectable `clientFactory` exactly. Type the constructor config as `EmailConfig & { clientFactory?: () => ImapFlowLike }`. Define a minimal `ImapFlowLike` type for the client surface used (connect, logout, list, mailboxCreate, getMailboxLock, fetch, messageMove, mailbox) so both the real `ImapFlow` and the test fake satisfy it.

- [ ] **Step 4: `imap-adapter.test.ts`**

`git mv src/email/client.test.js src/adapters/email/imap-adapter.test.ts`. Update import to `./imap-adapter.js` and class name to `ImapEmailAdapter`. Type the fake client to `ImapFlowLike`. Run → PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → 0 errors.
```bash
git add -A
git commit -m "refactor(adapters/email): ImapEmailAdapter + materialize in TS"
```

---

### Task 6: `adapters/trivi/`

**Files:**
- Create: `src/adapters/trivi/auth.ts` (from `src/trivi/auth.js`)
- Create: `src/adapters/trivi/upload-adapter.ts` + `.test.ts` (from `src/trivi/upload.js` + test)
- Delete: `src/trivi/auth.js`, `src/trivi/upload.js` (+test)

**Interfaces:**
- Consumes: `domain/payment.js` (`paymentTypeFromMethod`), `shared/retry.js` (`withRetry`, `defaultShouldRetry`), `ports/trivi-port.js`, `domain/types.js`.
- Produces: `class TriviAuth { getToken(): Promise<string> }`; `class TriviUploadAdapter implements TriviPort`.

- [ ] **Step 1: `auth.ts`**

`git mv src/trivi/auth.js src/adapters/trivi/auth.ts`. Add types: constructor `config: Pick<TriviConfig,'appId'|'appSecret'>`, private fields `#accessToken: string | null`, `#expiresAt: number`, `getToken(): Promise<string>`. Type the axios response `{ access_token: string; expires_in: number }`. Logic unchanged.

- [ ] **Step 2: `upload-adapter.ts`**

`git mv src/trivi/upload.js src/adapters/trivi/upload-adapter.ts`. Update imports: `../../domain/payment.js`, `../../shared/retry.js`. Rename class `TriviService` → `TriviUploadAdapter implements TriviPort` (import port). Keep the per-step `runUpload`/`runScan` internal retry and the HTML/no-id guards identical. Type the constructor `config: TriviConfig, auth: TriviAuth`. Type axios responses at the boundary (`{ id?: string | number }` for uploads; `unknown` for scans, keep the `<!doctype` string guard). Return type `Promise<UploadResult>`.

- [ ] **Step 3: `upload-adapter.test.ts`**

`git mv src/trivi/upload.test.js src/adapters/trivi/upload-adapter.test.ts`. Update import to `./upload-adapter.js` and class name. Type the axios mock and the fake auth. Run: `node --import tsx --test src/adapters/trivi/upload-adapter.test.ts` → PASS.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck` → 0 errors.
```bash
git add -A
git commit -m "refactor(adapters/trivi): TriviUploadAdapter + TriviAuth in TS"
```

---

### Task 7: `adapters/mistral/`

**Files:**
- Create: `src/adapters/mistral/classifier-adapter.ts` + `.test.ts` (the `DocumentClassifier` part of `src/classify/classifier.js` + adapter tests from `src/classify/classifier.test.js`)
- Delete: `src/classify/classifier.js`, `src/classify/classifier.test.js` (the `parseClassification`/`guessMimeType` parts already moved to `domain/classification.ts` in Task 2)

**Interfaces:**
- Consumes: `domain/classification.js` (`parseClassification`, `guessMimeType`), `domain/types.js`, `ports/classifier-port.js`.
- Produces: `class MistralClassifierAdapter implements ClassifierPort`; re-export or keep `DEFAULT_CLASSIFIER_MODEL`, `OCR_MODEL` if referenced elsewhere (grep first).

- [ ] **Step 1: `classifier-adapter.ts`**

Create from the `DocumentClassifier` class in `src/classify/classifier.js`. Rename to `MistralClassifierAdapter implements ClassifierPort`. Import `parseClassification`, `guessMimeType` from `../../domain/classification.js`. Keep the vision-vs-OCR routing, HEIC→JPEG conversion, `INSTRUCTIONS`/`JSON_SPEC` prompt constants, and `temperature: 0` exactly. Type the constructor `config: Pick<MistralConfig,'apiKey'|'classifierModel'>`, `classifyAttachment(attachment: Attachment, context?: ClassifyContext): Promise<Classification>`. Type the Mistral SDK response access defensively (`res.choices?.[0]?.message?.content`).

- [ ] **Step 2: `classifier-adapter.test.ts`**

Port the adapter-level tests (routing, HEIC handling) from `src/classify/classifier.test.js` (the `parseClassification` tests already live in `domain/classification.test.ts`). Mock the Mistral client. Run → PASS.

- [ ] **Step 3: Verify no dangling imports**

Run: `grep -rn "classify/classifier" src/ || echo clean` → clean (all references updated).
Run: `npm run typecheck` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(adapters/mistral): MistralClassifierAdapter in TS"
```

---

### Task 8: `adapters/aws/`

**Files:**
- Create: `src/adapters/aws/s3-storage.ts` (from `src/aws/storage.js`)
- Create: `src/adapters/aws/sns-notification.ts` (from `src/aws/notifications.js`)
- Create: `src/adapters/aws/secrets.ts` (the `loadFromSecretsManager` extracted from `src/config.js`)
- Delete: `src/aws/storage.js`, `src/aws/notifications.js`

**Interfaces:**
- Consumes: `ports/storage-port.js`, `ports/notification-port.js`, `domain/types.js`.
- Produces: `class S3StorageAdapter implements StoragePort`, `class SnsNotificationAdapter implements NotificationPort`, `loadFromSecretsManager(secretName: string): Promise<AppConfig>`.

- [ ] **Step 1: `s3-storage.ts`**

`git mv src/aws/storage.js src/adapters/aws/s3-storage.ts`. Rename `StorageService` → `S3StorageAdapter implements StoragePort`. Type constructor `config: S3Config`. Keep the "no bucket → log & skip" best-effort behavior identical. `archiveEmail(emailId: string, content: string): Promise<void>`.

- [ ] **Step 2: `sns-notification.ts`**

`git mv src/aws/notifications.js src/adapters/aws/sns-notification.ts`. Rename `NotificationService` → `SnsNotificationAdapter implements NotificationPort`. Type constructor `config: NotificationConfig`. Keep both methods and the "no topic → log" behavior identical.

- [ ] **Step 3: `secrets.ts`**

Create `src/adapters/aws/secrets.ts` with `loadFromSecretsManager` moved out of config.js:

```ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { AppConfig } from '../../domain/types.js';

export async function loadFromSecretsManager(secretName: string): Promise<AppConfig> {
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
  return JSON.parse(response.SecretString ?? '{}') as AppConfig;
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck` → 0 errors.
```bash
git add -A
git commit -m "refactor(adapters/aws): S3StorageAdapter, SnsNotificationAdapter, secrets in TS"
```

---

### Task 9: `application/` layer

**Files:**
- Create: `src/application/process-invoices.ts` + `.test.ts` (from `src/pipeline/run.js` + `src/pipeline/run.test.js`)
- Create: `src/application/summary.ts` + `.test.ts` (from `src/pipeline/summary.js` + test)
- Delete: `src/pipeline/run.js` (+test), `src/pipeline/summary.js` (+test); the now-empty `src/pipeline/` directory

**Interfaces:**
- Consumes: `ports/services.js` (`Services`), `domain/attachment-filter.js` (`isInvoiceAttachment`), `domain/types.js`, `ports/notification-port.js`.
- Produces: `processInvoices(svc: Services): Promise<ProcessResult[]>`, `processEmail(msg: EmailMessage, svc: Services): Promise<ProcessResult>`, `buildSummaryLines(results: ProcessResult[]): string[]`, `sendSummary(results: ProcessResult[], notification: NotificationPort): Promise<void>`.

- [ ] **Step 1: `summary.ts` + test**

`git mv src/pipeline/summary.js src/application/summary.ts`. Add types per Interfaces. Logic unchanged (Czech strings preserved). `git mv src/pipeline/summary.test.js src/application/summary.test.ts`; fix import `./summary.js`. Run → PASS.

- [ ] **Step 2: `process-invoices.ts`**

`git mv src/pipeline/run.js src/application/process-invoices.ts`. Update imports: `./summary.js`, `../domain/attachment-filter.js`, `node:fs/promises`. Add types: `processInvoices(svc: Services)`, `processEmail(msg: EmailMessage, svc: Services)`, typed `result: ProcessResult`. Keep the connect/disconnect lifecycle, the fatal IMAP path, per-email isolation, mark-ordering, archive best-effort, and cleanup exactly as they are.

- [ ] **Step 3: `process-invoices.test.ts`**

`git mv src/pipeline/run.test.js src/application/process-invoices.test.ts`. Fix imports. Type the mock `Services` (the mock adapters typed as their ports; use `as unknown as Services` at the seam if a partial mock is easier, but prefer typing each mock to its port). Run: `node --import tsx --test src/application/process-invoices.test.ts` → PASS.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck` → 0 errors.
```bash
git add -A
git commit -m "refactor(application): processInvoices/processEmail + summary in TS"
```

---

### Task 10: composition root — `config.ts` + `handler.ts`

**Files:**
- Create: `src/config.ts` (from `src/config.js`, minus the secrets loader now in `adapters/aws/secrets.ts`)
- Create: `src/handler.ts` (from `src/handler.js`)
- Delete: `src/config.js`, `src/config.test.js` → recreate as `.ts`; delete `src/handler.js`

**Interfaces:**
- Consumes: everything — `adapters/*`, `application/process-invoices.js`, `shared/retry.js`, `config.js`.
- Produces: `loadConfig(): Promise<AppConfig>`, `assertConfig(cfg: AppConfig): AppConfig`, `handler` (Sentry-wrapped Lambda entry).

- [ ] **Step 1: `config.ts`**

`git mv src/config.js src/config.ts`. Import `loadFromSecretsManager` from `./adapters/aws/secrets.js`. Keep `loadFromEnv`, `assertConfig`, `requireEnv`, `isNonEmptyString`. Type `loadConfig(): Promise<AppConfig>`, `assertConfig(cfg: AppConfig): AppConfig`, `loadFromEnv(): AppConfig`. `git mv src/config.test.js src/config.test.ts`; fix imports; type env manipulation. Run: `node --import tsx --test src/config.test.ts` → PASS.

- [ ] **Step 2: `handler.ts`**

`git mv src/handler.js src/handler.ts`. Update imports to the new adapter paths:
```ts
import { loadConfig } from './config.js';
import { TriviAuth } from './adapters/trivi/auth.js';
import { TriviUploadAdapter } from './adapters/trivi/upload-adapter.js';
import { ImapEmailAdapter } from './adapters/email/imap-adapter.js';
import { S3StorageAdapter } from './adapters/aws/s3-storage.js';
import { SnsNotificationAdapter } from './adapters/aws/sns-notification.js';
import { MistralClassifierAdapter } from './adapters/mistral/classifier-adapter.js';
import { processInvoices } from './application/process-invoices.js';
import { log } from './shared/logger.js';
import { emitMetrics } from './shared/metrics.js';
import * as Sentry from '@sentry/aws-serverless';
import type { Services } from './ports/services.js';
```
`setup(): Promise<Services>` builds the adapters (typed to `Services`). Keep the Sentry guard (`if (process.env.SENTRY_DSN)`), `Sentry.wrapHandler`, warm-start `services` caching, structured `log.*` lifecycle lines, `emitMetrics(...)`, and the 200/207 return shape identical. Type the Lambda handler `(event: unknown, context: { awsRequestId: string })`.

- [ ] **Step 3: Full typecheck + full suite**

Run: `npm run typecheck` → 0 errors.
Run: `npm test` → all tests pass (94+, minus none).
Run: `grep -rn --include='*.js' . src 2>/dev/null | grep -v node_modules | grep 'src/' || echo "no .js left in src"` → confirms no `.js` remains under `src/`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: TypeScript composition root (config + Sentry-wrapped handler)"
```

---

### Task 11: build & deploy plumbing

**Files:**
- Modify: `Dockerfile` (multi-stage)
- Modify: `docker-compose.yml` (import path)
- Modify: `.github/workflows/*` (typecheck + test on TS)

**Interfaces:**
- Produces: a runnable Lambda image running `dist/handler.handler`.

- [ ] **Step 1: Multi-stage `Dockerfile`**

```dockerfile
FROM public.ecr.aws/lambda/nodejs:22 AS builder
WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM public.ecr.aws/lambda/nodejs:22
WORKDIR ${LAMBDA_TASK_ROOT}
COPY package*.json ./
RUN npm ci --production
COPY --from=builder /build/dist ./dist
CMD ["dist/handler.handler"]
```

- [ ] **Step 2: `docker-compose.yml`**

Change the `node -e` command's import from `./src/handler.js` to `./dist/handler.js`. Keep the AWS-disabling env (`SECRET_NAME=`, `SNS_TOPIC_ARN=`, `S3_BUCKET=`).

- [ ] **Step 3: CI**

In `.github/workflows/*.yml`, ensure the pipeline runs `npm ci`, `npm run typecheck`, `npm test` (and `npm run build` if it builds an image). Read the existing workflow first and adapt minimally.

- [ ] **Step 4: Build + smoke run**

Run: `docker compose build` → succeeds.
Run: `docker compose up` → the compiled `dist/handler.js` loads, connects to configured IMAP (or fails cleanly if `.env` not set), prints the result object. This is the end-to-end gate.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .github
git commit -m "build: multi-stage Docker (tsc build stage), compose dist path, CI typecheck"
```

---

### Task 12: docs & cleanup

**Files:**
- Delete: `LOCAL_AWS_SWITCH_NOTE.md` (after folding the AWS checklist into AGENTS.md)
- Delete: `.superpowers/sdd/` (local, un-gitted)
- Modify: `README.md`, `AGENTS.md`

- [ ] **Step 1: Fold the AWS deploy checklist into `AGENTS.md`**

Add a "Deployment (AWS)" subsection under Configuration/Security capturing the unique content of `LOCAL_AWS_SWITCH_NOTE.md`: in prod set `SECRET_NAME`; Lambda role needs Secrets Manager `GetSecretValue`, SNS `Publish` (if used), S3 `PutObject` (if used); dry-run in staging before the production schedule.

- [ ] **Step 2: Rewrite `AGENTS.md` structure sections**

Update the architecture data-flow, the layer table (new hexagonal paths), add a "Ports" list, update Commands (`build`/`typecheck`/`test` via tsx), note the NodeNext `.js`-import-extension rule, note the source is now TS, and note `docs/superpowers/specs/2026-07-02-clean-architecture-refactor` is superseded by the TS migration spec.

- [ ] **Step 3: Rewrite `README.md`**

Minimal real README: one paragraph (email→classify→TRIVI upload, daily Lambda), quickstart (`npm install`, `npm test`, `npm run build`, `docker compose up`), and "See `AGENTS.md` for architecture and invariants."

- [ ] **Step 4: Delete cruft**

```bash
git rm LOCAL_AWS_SWITCH_NOTE.md
rm -rf .superpowers/sdd
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: rewrite README + AGENTS for TS/hexagonal, drop stale LOCAL_AWS_SWITCH_NOTE"
```

---

### Task 13: final verification

- [ ] **Step 1: Clean-room checks**

Run: `npm run typecheck` → 0 errors.
Run: `npm test` → all pass.
Run: `find src -name '*.js' | grep . && echo "FAIL: .js left" || echo "OK: src is all TS"`.
Run: `grep -rnE '(^|[^:*])//|/\*[^*]' src --include='*.ts' | grep -vE "https?://|'/'|/\*\*" || echo "no comments"`.

- [ ] **Step 2: Build + smoke**

Run: `docker compose build && docker compose up` → end-to-end run prints a result object; behavior matches pre-migration.

- [ ] **Step 3: Final commit (if any residual)**

```bash
git add -A
git commit -m "chore: finalize TypeScript hexagonal migration" || echo "nothing to finalize"
```
