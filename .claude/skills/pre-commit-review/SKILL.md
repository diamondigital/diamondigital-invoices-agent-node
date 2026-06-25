---
name: pre-commit-review
description: Use before committing or opening a PR in diamondigital-invoices-agent-node. Reviews the staged/working diff for repo-specific risks — leaked secrets, broken pipeline invariants (processed-marking order, no-dedup, INBOX-as-queue), retry/error-isolation regressions, and ESM/config drift. Run it after finishing a change and before `git commit`.
---

# Pre-commit review

Review the current diff against this repo's invariants **before** committing. This is a
quality gate, not a rewrite. Read `AGENTS.md` for the full invariant list.

## How to run

1. Get the diff:
   ```bash
   git status --short
   git diff            # unstaged
   git diff --cached   # staged
   ```
2. Walk the checklist below against every changed hunk.
3. Report findings grouped **Blocker / Warning / Nit**. Don't fix silently — surface
   first, fix only what's asked or clearly safe.

## Checklist

### 1. Secrets (BLOCKER)
- No real credentials in the diff. Grep the change for accidental secrets:
  ```bash
  git diff --cached | grep -iE 'secret|password|appSecret|token|api[_-]?key' 
  ```
- `.env` must never be staged (it's gitignored — confirm it stays out).
- `.env.example` must contain **placeholders only** (`***`), never live values. Note: the
  committed example currently has real-looking values that should be rotated — don't add more.

### 2. Pipeline invariants (BLOCKER if violated)
- **Mark-processed ordering**: an email is moved out of INBOX (`markAsProcessed`) only
  after a successful TRIVI upload (`result.success`). The diff must not reorder this.
- **No new duplicate risk**: changes around upload↔move must not create a window where an
  upload succeeds but the email is reprocessed next run (there is no dedup).
- **Per-email error isolation**: per-email work stays inside the loop's try/catch; one
  email's failure must not abort the batch. Only IMAP fetch is allowed to be fatal.
- **Best-effort stays best-effort**: S3 archive and SNS failures must remain warn-only,
  not throw.
- **HTML-response guard** in `uploadDocumentAttachment` is intact.

### 3. Config & ESM hygiene (WARNING)
- New env var? It must be in `.env.example` AND `config.js` (`loadFromEnv`) AND, for prod,
  the Secrets Manager JSON shape. `requireEnv` only for truly mandatory vars.
- `import`/ESM only (`"type": "module"`). No `require`, no CommonJS.
- New AWS capability → corresponding IAM in `terraform/`.

### 4. Style & tests (NIT / WARNING)
- File header comment + `[area]`-prefixed logs match existing style.
- User-facing strings (summary/alerts) stay Czech; logs English.
- Logic-heavy change with no test? `npm test` is wired (`node:test`) but empty — recommend
  adding a `*.test.js` next to the changed file.

## Output

```
Pre-commit review — <branch>
Blockers:  <n>  (must fix before commit)
Warnings:  <n>
Nits:      <n>

[Blocker] file:line — what's wrong, why it breaks an invariant, the fix
...
Verdict: SAFE TO COMMIT / FIX BLOCKERS FIRST
```
