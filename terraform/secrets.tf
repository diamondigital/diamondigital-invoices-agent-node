# terraform/secrets.tf
resource "aws_secretsmanager_secret" "app" {
  name = var.project_name
}

# Set the secret value after apply:
# aws secretsmanager put-secret-value \
#   --secret-id diamondigital-invoices-agent-node \
#   --secret-string '{"email":{"host":"imap.seznam.cz","port":993,"secure":true,"user":"invoices@diamondigital.cz","password":"<EMAIL_PASSWORD>"},"trivi":{"appId":"<TRIVI_APP_ID>","appSecret":"<TRIVI_APP_SECRET>","baseUrl":"https://api.trivi.com/v2","bankAccountId":0},"mistral":{"apiKey":"<MISTRAL_API_KEY>","model":"mistral-large-latest"},"notification":{"snsTopicArn":"","adminEmail":"admin@diamondigital.cz"},"s3":{"bucketName":"diamondigital-invoices-archive"}}'
