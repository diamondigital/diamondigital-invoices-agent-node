import { loadConfig } from './config.js';
import { TriviAuth } from './trivi/auth.js';
import { TriviService } from './trivi/upload.js';
import { EmailService } from './email/client.js';
import { StorageService } from './aws/storage.js';
import { NotificationService } from './aws/notifications.js';
import { DocumentClassifier } from './classify/classifier.js';
import { withRetry } from './lib/retry.js';
import { processInvoices } from './pipeline/run.js';

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

  trivi.uploadDocumentAttachment = withRetry(trivi.uploadDocumentAttachment.bind(trivi), {
    maxAttempts: 3, baseDelayMs: 1000,
  });

  console.log('[setup] Services initialized');
  return { cfg, trivi, email, storage, notification, classifier };
}

export const handler = async (event, context) => {
  console.log(`[lambda] Invocation: ${context.awsRequestId}`);

  if (!services) {
    services = await setup();
  }

  let results;
  try {
    results = await processInvoices(services);
  } catch (error) {
    console.error(`[lambda] Fatal error: ${error.message}`);
    throw error;
  }

  const ok = results.filter(r => r.success).length;
  const skipped = results.filter(r => !r.success && r.skipped).length;
  const fail = results.filter(r => !r.success && !r.skipped).length;

  console.log(`[lambda] Done: ${results.length} processed, ${ok} ok, ${skipped} skipped, ${fail} failed`);

  return {
    statusCode: fail > 0 ? 207 : 200,
    body: JSON.stringify({
      processed: results.length,
      successful: ok,
      skipped,
      failed: fail,
    }),
  };
};
