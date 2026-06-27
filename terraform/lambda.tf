# terraform/lambda.tf
resource "aws_lambda_function" "app" {
  function_name = var.project_name
  role          = aws_iam_role.lambda_exec.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.app.repository_url}:latest"
  memory_size   = var.lambda_memory
  timeout       = var.lambda_timeout

  environment {
    variables = {
      NODE_ENV    = "production"
      SECRET_NAME = aws_secretsmanager_secret.app.name
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    aws_iam_role_policy_attachment.lambda_secrets,
    aws_iam_role_policy_attachment.lambda_sns,
  ]
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.project_name}"
  retention_in_days = 30
}
