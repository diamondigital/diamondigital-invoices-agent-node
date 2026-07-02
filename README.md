# diamondigital-invoices-agent-node

Pulls unprocessed emails from a mailbox via IMAP, classifies invoice-like
attachments with Mistral, and uploads the ones that qualify as accounting
documents to TRIVI's "uploaded documents" inbox. Runs as a daily AWS Lambda
(EventBridge schedule); can also run locally against a real or disabled AWS
config.

## Quickstart

```bash
npm install
npm test
npm run build
docker compose up --build   # local run with AWS disabled (S3/SNS/Secrets Manager off)
```

See [AGENTS.md](AGENTS.md) for the architecture, invariants, and conventions
that govern this repo — it is the source of truth for anyone (human or agent)
changing this code.
