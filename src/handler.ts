import { loadConfig } from './config.js';
import { TriviAuth } from './adapters/trivi/auth.js';
import { TriviUploadAdapter } from './adapters/trivi/upload-adapter.js';
import { ImapEmailAdapter } from './adapters/email/imap-adapter.js';
import { S3StorageAdapter } from './adapters/aws/s3-storage.js';
import { SnsNotificationAdapter } from './adapters/aws/sns-notification.js';
import { MistralClassifierAdapter } from './adapters/mistral/classifier-adapter.js';
import { processInvoices } from './application/process-invoices.js';
import { log } from './shared/logger.js';
import { emitMetrics } from './shared/metrics.js';
import * as Sentry from '@sentry/aws-serverless';
import type { Services } from './ports/services.js';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
  });
}

let services: Services | null = null;

async function setup(): Promise<Services> {
  const cfg = await loadConfig();
  const triviAuth = new TriviAuth(cfg.trivi);
  const trivi = new TriviUploadAdapter(cfg.trivi, triviAuth);
  const email = new ImapEmailAdapter(cfg.email);
  const storage = new S3StorageAdapter(cfg.s3);
  const notification = new SnsNotificationAdapter(cfg.notification);

  const classifier = cfg.mistral.apiKey
    ? new MistralClassifierAdapter(cfg.mistral)
    : null;
  if (!classifier) {
    console.warn('[setup] MISTRAL_API_KEY missing — classification disabled, all invoice-like attachments will be uploaded');
  }

  console.log('[setup] Services initialized');
  return { cfg, trivi, email, storage, notification, classifier };
}

export const handler = Sentry.wrapHandler(async (event: unknown, context: { awsRequestId: string }) => {
  log.info('lambda', 'Invocation', { requestId: context.awsRequestId });

  if (!services) {
    services = await setup();
  }

  let results;
  try {
    results = await processInvoices(services);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('lambda', 'Fatal error', { requestId: context.awsRequestId, error: message });
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
