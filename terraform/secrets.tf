# terraform/secrets.tf
resource "aws_secretsmanager_secret" "app" {
  name = var.project_name
}

# Set the secret value after apply:
# aws secretsmanager put-secret-value \
#   --secret-id diamondigital-invoices-agent-node \
#   --secret-string '{"email":{"host":"imap.seznam.cz","port":993,"secure":true,"user":"invoices@diamondigital.cz","password":"..."},"trivi":{"appId":"***REDACTED-TRIVI-APP-ID***","appSecret":"***REDACTED-TRIVI-APP-SECRET***","baseUrl":"https://api.trivi.com/v2","bankAccountId":0},"mistral":{"apiKey":"***REDACTED-MISTRAL-KEY***","model":"mistral-large-latest"},"notification":{"snsTopicArn":"","adminEmail":"admin@diamondigital.cz"},"s3":{"bucketName":"diamondigital-invoices-archive"}}'
