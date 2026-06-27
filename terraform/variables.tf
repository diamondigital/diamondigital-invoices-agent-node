# terraform/variables.tf
variable "aws_region" {
  default = "eu-central-1"
}

variable "project_name" {
  default = "diamondigital-invoices-agent-node"
}

variable "lambda_memory" {
  default = 512
}

variable "lambda_timeout" {
  default = 300
}

variable "schedule_expression" {
  description = "Cron expression (UTC). Runs twice daily: 04:00 + 16:00 UTC (= 06:00 + 18:00 CEST)"
  default     = "cron(0 4,16 * * ? *)"
}

variable "admin_email" {
  default = "admin@diamondigital.cz"
}
