import { loadFromSecretsManager } from './adapters/aws/secrets.js';
import type { AppConfig } from './domain/types.js';

export async function loadConfig(): Promise<AppConfig> {
  const secretName = process.env.SECRET_NAME;
  if (secretName) {
    return assertConfig(await loadFromSecretsManager(secretName));
  }
  return assertConfig(loadFromEnv());
}

export function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}

export function assertConfig(cfg: AppConfig): AppConfig {
  const problems: string[] = [];
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

export function loadFromEnv(): AppConfig {
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

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
