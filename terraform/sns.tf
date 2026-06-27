# terraform/sns.tf
resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.admin_email
}

output "sns_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "lambda_function_name" {
  value = aws_lambda_function.app.function_name
}
