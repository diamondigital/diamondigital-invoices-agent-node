---
name: local-smoke-test
description: Use to safely run the email→TRIVI upload agent locally and interpret the result, without touching production. Covers docker-compose and node invocation, the AWS-disabling env overrides, and how to read the daily summary / log prefixes. Invoke when asked to run, smoke-test, or verify a change works against a local config.
---

# Local smoke test

Run the agent locally and confirm a change works, without hitting AWS. Read
`LOCAL_AWS_SWITCH_NOTE.md` and `AGENTS.md` before a first run.

## ⚠️ This is not a dry run

The agent talks to **real IMAP and the real TRIVI API**. A successful run **uploads
attachments to TRIVI and moves the source emails out of INBOX**. Before running:

- Confirm with the user which mailbox/TRIVI account `.env` points at (prod vs test).
- If unsure, stop and ask. Do not run against a production mailbox to "see what happens".
- Keep `S3_BUCKET` and `SNS_TOPIC_ARN` empty for local runs (log-only, no AWS calls).

## Setup

1. `cp .env.example .env` (if `.env` is missing) and fill real values. `.env` is gitignored.
2. Ensure local mode: `SECRET_NAME` empty → config loads from `.env`, not Secrets Manager.

## Run

Option A — docker-compose (matches the documented local setup):
```bash
docker compose up --build
```
It overrides `entrypoint` to `node`, forces `SECRET_NAME`/`SNS_TOPIC_ARN`/`S3_BUCKET`
empty, and invokes `handler({}, { awsRequestId: 'docker-local-run' })` via `node -e`.

Option B — node directly:
```bash
npm run dev     # node --watch src/handler.js --local
# or invoke the handler:
node -e "import('./src/handler.js').then(({handler}) => handler({}, {awsRequestId:'local'})).then(console.log)"
```

## Read the result

The handler returns:
```json
{ "statusCode": 200|207, "body": "{\"processed\":N,\"successful\":N,\"failed\":N}" }
```
- `statusCode 200` = all good; `207` = at least one email failed.
- The Czech daily summary is logged (or sent via SNS if configured).

Log prefixes to scan: `[setup]`, `[email]`, `[trivi]`, `[retry]`, `[warn]`, `[error]`,
`[fatal]`, `[lambda]`.

## Interpreting outcomes

| You see | Meaning |
|---|---|
| `No unprocessed emails` | INBOX empty — nothing to do (not a failure). |
| `[skip] No invoice-like attachment` | Filter rejected the attachments (extension/MIME). |
| `[trivi] ... returned HTML instead of JSON` | Wrong TRIVI endpoint config — hand to `pipeline-triage`. |
| `[retry] Attempt n/3 failed` | Transient upload error; watch whether it recovers. |
| `[fatal] IMAP fetch failed` | Connection/auth problem — the run aborts. |
| `[warn] Failed to tag email ... as processed` | Duplicate risk next run (no dedup). |

If a run fails or behaves oddly, switch to the `pipeline-triage` agent rather than guessing.

## After testing

There is no auto-cleanup of TRIVI uploads or moved emails. If you ran against a shared
account, tell the user exactly what was uploaded/moved (the summary lists uploaded docs).
