import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

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
      processedLabel: process.env.EMAIL_PROCESSED_LABEL || 'TRIVI',
      skippedFolder: process.env.EMAIL_SKIPPED_FOLDER || 'Bez dokladu',
    },
    trivi: {
      appId: requireEnv('TRIVI_APP_ID'),
      appSecret: requireEnv('TRIVI_APP_SECRET'),
      baseUrl: process.env.TRIVI_BASE_URL || 'https://api.trivi.com/v2',
      uploadsPath: '/uploads',
      scansPath: '/accountingdocuments/scans',
      uploadFieldName: 'file',
    },
    mistral: {
      apiKey: process.env.MISTRAL_API_KEY || '',
      classifierModel: process.env.MISTRAL_CLASSIFIER_MODEL || 'ministral-8b-latest',
      uploadThreshold: parseFloat(process.env.MISTRAL_UPLOAD_THRESHOLD || '0.85'),
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
