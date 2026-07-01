# terraform/github-oidc.tf
# GitHub Actions OIDC deploy role used by .github/workflows/deploy.yml.
# These resources were bootstrapped via the AWS CLI so the pipeline could run
# immediately. If you hold the terraform state, import them once so the IaC
# stays authoritative — no re-creation needed:
#
#   terraform import aws_iam_openid_connect_provider.github \
#     arn:aws:iam::711928969932:oidc-provider/token.actions.githubusercontent.com
#   terraform import aws_iam_role.github_deploy github-actions-invoices-deploy
#   terraform import aws_iam_role_policy.github_deploy \
#     github-actions-invoices-deploy:ecr-push-and-lambda-deploy

variable "github_repo" {
  description = "owner/repo allowed to assume the deploy role"
  default     = "diamondigital/diamondigital-invoices-agent-node"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bba010a51b5d24df6f81b03d78e14b",
    "1c58a3a8518e8759bf075b76b750d4f2df264fca",
  ]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "github-actions-invoices-deploy"
  description        = "GitHub Actions OIDC deploy role for ${var.project_name} (push to main)"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPush"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid    = "LambdaDeploy"
    effect = "Allow"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
    ]
    resources = [aws_lambda_function.app.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "ecr-push-and-lambda-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
