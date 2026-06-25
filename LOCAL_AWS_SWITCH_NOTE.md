# Local <-> AWS switch note

This repository is currently configured for **local run without AWS** in [docker-compose.yml](docker-compose.yml).
The runtime flow now uploads invoice-like email attachments to TRIVI uploaded documents instead of creating accounting invoices.

## What was changed for local-only mode

In [docker-compose.yml](docker-compose.yml):
- `entrypoint` is overridden to `node` for local invocation.
- `SECRET_NAME` is forced to empty.
- `SNS_TOPIC_ARN` and `S3_BUCKET` are forced to empty.
- Container command invokes Lambda `handler(...)` directly via `node -e`.

## Revert to AWS mode (when ready)

1. Keep your AWS infra in Terraform as source of truth.
2. In runtime environment (Lambda/ECS), set `SECRET_NAME` to your AWS Secrets Manager secret name.
3. Remove local overrides that disable AWS:
- `entrypoint: ["node"]`
- `SECRET_NAME=`
- `SNS_TOPIC_ARN=`
- `S3_BUCKET=`
4. Restore normal Lambda-style container command.

Recommended AWS-oriented compose/service command:

```yaml
command: ["src/index.handler"]
```

If you run the app outside Lambda and still want Node execution, use the current `node -e` invocation only for local testing.

## Config behavior reminder

- [src/config.js](src/config.js):
  - If `SECRET_NAME` is set -> loads from AWS Secrets Manager.
  - If `SECRET_NAME` is missing/empty -> loads from environment variables.
- [src/trivi-service.js](src/trivi-service.js): uploaded documents default to `TRIVI_BASE_URL + /accountingdocuments/uploaded` and use multipart field `file` unless overridden.
- [src/notification-service.js](src/notification-service.js): SNS is used only when `SNS_TOPIC_ARN` is set.
- [src/storage-service.js](src/storage-service.js): S3 is used only when bucket is set.

## Safe deployment checklist for AWS

1. Rotate any credentials that were ever stored in local `.env` or `.env.example`.
2. Put all secrets in AWS Secrets Manager.
3. Ensure Lambda execution role has permissions for:
- Secrets Manager `GetSecretValue`
- SNS `Publish` (if used)
- S3 `PutObject` (if used)
4. Test one dry run in staging before production schedule.
