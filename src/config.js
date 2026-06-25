// src/config.js — Load credentials from AWS Secrets Manager (prod) or .env (local)
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * @returns {Promise<{
 *   email: {host:string, port:number, secure:boolean, user:string, password:string},
 *   trivi: {appId:string, appSecret:string, baseUrl:string, bankAccountId:number, uploadedDocumentsPath:string, uploadFieldName:string},
 *   mistral: {apiKey:string, model:string},
 *   notification: {snsTopicArn:string, adminEmail:string},
 *   s3: {bucketName:string}
 * }>}
 */
export async function loadConfig() {
  const secretName = process.env.SECRET_NAME;
  if (secretName) {
    return loadFromSecretsManager(secretName);
  }
  return loadFromEnv();
}

function loadFromEnv() {
  return {
    email: {
      host: requireEnv('EMAIL_HOST'),
      port: parseInt(requireEnv('EMAIL_PORT'), 10),
      secure: process.env.EMAIL_SECURE === 'true',
      user: requireEnv('EMAIL_USER'),
      password: requireEnv('EMAIL_PASSWORD'),
    },
    trivi: {
      appId: requireEnv('TRIVI_APP_ID'),
      appSecret: requireEnv('TRIVI_APP_SECRET'),
      baseUrl: process.env.TRIVI_BASE_URL || 'https://api.trivi.com/v2',
      bankAccountId: parseInt(process.env.TRIVI_BANK_ACCOUNT_ID || '0', 10),
		uploadedDocumentsPath: process.env.TRIVI_UPLOADED_DOCUMENTS_PATH || '/accountingdocuments/uploaded',
		uploadFieldName: process.env.TRIVI_UPLOAD_FIELD_NAME || 'file',
    },
    mistral: {
		apiKey: process.env.MISTRAL_API_KEY || '',
      model: process.env.MISTRAL_MODEL || 'mistral-large-latest',
    },
    notification: {
      snsTopicArn: process.env.SNS_TOPIC_ARN || '',
      adminEmail: process.env.ADMIN_EMAIL || 'admin@diamondigital.cz',
    },
    s3: {
		bucketName: process.env.S3_BUCKET || '',
    },
  };
}

async function loadFromSecretsManager(secretName) {
  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );
  return JSON.parse(response.SecretString);
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
