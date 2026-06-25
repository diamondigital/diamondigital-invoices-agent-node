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
  description = "Cron expression (UTC). Default: 4:00 UTC = 6:00 CET"
  default     = "cron(0 4 * * ? *)"
}

variable "admin_email" {
  default = "admin@diamondigital.cz"
}
