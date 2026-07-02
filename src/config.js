import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * @returns {Promise<import('./types.js').AppConfig>}
 */
export async function loadConfig() {
  const secretName = process.env.SECRET_NAME;
  if (secretName) {
    return assertConfig(await loadFromSecretsManager(secretName));
  }
  return assertConfig(loadFromEnv());
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * @param {import('./types.js').AppConfig} cfg
 * @returns {import('./types.js').AppConfig}
 */
export function assertConfig(cfg) {
  const problems = [];
  const email = cfg?.email;
  const trivi = cfg?.trivi;

  if (!isNonEmptyString(email?.host)) problems.push('email.host');
  if (!(typeof email?.port === 'number' && Number.isFinite(email.port) && email.port > 0)) {
    problems.push('email.port');
  }
  if (!isNonEmptyString(email?.user)) problems.push('email.user');
  if (!isNonEmptyString(email?.password)) problems.push('email.password');
  if (!isNonEmptyString(trivi?.appId)) problems.push('trivi.appId');
  if (!isNonEmptyString(trivi?.appSecret)) problems.push('trivi.appSecret');

  if (problems.length > 0) {
    throw new Error(`Invalid config: missing/invalid ${problems.join(', ')}`);
  }
  return cfg;
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

/**
 * @param {string} secretName
 * @returns {Promise<import('./types.js').AppConfig>}
 */
async function loadFromSecretsManager(secretName) {
  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );
  return JSON.parse(response.SecretString);
}

/**
 * @param {string} name
 * @returns {string}
 */
function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
