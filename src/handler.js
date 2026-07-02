import { loadConfig } from './config.js';
import { TriviAuth } from './trivi/auth.js';
import { TriviService } from './trivi/upload.js';
import { EmailService } from './email/client.js';
import { StorageService } from './aws/storage.js';
import { NotificationService } from './aws/notifications.js';
import { DocumentClassifier } from './classify/classifier.js';
import { processInvoices } from './pipeline/run.js';
import { log } from './lib/logger.js';
import { emitMetrics } from './lib/metrics.js';
import * as Sentry from '@sentry/aws-serverless';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
  });
}

let services = null;

async function setup() {
  const cfg = await loadConfig();
  const triviAuth = new TriviAuth(cfg.trivi);
  const trivi = new TriviService(cfg.trivi, triviAuth);
  const email = new EmailService(cfg.email);
  const storage = new StorageService(cfg.s3);
  const notification = new NotificationService(cfg.notification);

  const classifier = cfg.mistral.apiKey
    ? new DocumentClassifier(cfg.mistral)
    : null;
  if (!classifier) {
    console.warn('[setup] MISTRAL_API_KEY missing — classification disabled, all invoice-like attachments will be uploaded');
  }

  console.log('[setup] Services initialized');
  return { cfg, trivi, email, storage, notification, classifier };
}

export const handler = Sentry.wrapHandler(async (event, context) => {
  log.info('lambda', 'Invocation', { requestId: context.awsRequestId });

  if (!services) {
    services = await setup();
  }

  let results;
  try {
    results = await processInvoices(services);
  } catch (error) {
    log.error('lambda', 'Fatal error', { requestId: context.awsRequestId, error: error.message });
    throw error;
  }

  const ok = results.filter(r => r.success).length;
  const skipped = results.filter(r => !r.success && r.skipped).length;
  const fail = results.filter(r => !r.success && !r.skipped).length;

  log.info('lambda', 'Done', {
    requestId: context.awsRequestId,
    processed: results.length,
    ok,
    skipped,
    failed: fail,
  });

  emitMetrics({ processed: results.length, successful: ok, skipped, failed: fail });

  return {
    statusCode: fail > 0 ? 207 : 200,
    body: JSON.stringify({
      processed: results.length,
      successful: ok,
      skipped,
      failed: fail,
    }),
  };
});
