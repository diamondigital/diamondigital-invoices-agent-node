// src/index.js — AWS Lambda handler: Diamondigital Documents Upload Agent
import { loadConfig } from './config.js';
import { TriviAuth } from './trivi-auth.js';
import { TriviService } from './trivi-service.js';
import { EmailService } from './email-service.js';
import { StorageService } from './storage-service.js';
import { NotificationService } from './notification-service.js';
import { withRetry } from './retry.js';
import fs from 'node:fs/promises';

// ─── Warm-start cache ──────────────────────────────────

/** @type {Awaited<ReturnType<typeof setup>> | null} */
let services = null;

async function setup() {
  const cfg = await loadConfig();
  const triviAuth = new TriviAuth(cfg.trivi);
	const trivi = new TriviService(cfg.trivi, triviAuth);
  const email = new EmailService(cfg.email);
  const storage = new StorageService(cfg.s3);
  const notification = new NotificationService(cfg.notification);

  // Wrap critical TRIVI calls with retry
	trivi.uploadDocumentAttachment = withRetry(trivi.uploadDocumentAttachment.bind(trivi), {
    maxAttempts: 3, baseDelayMs: 1000,
	});

  console.log('[setup] Services initialized');
	return { cfg, trivi, email, storage, notification };
}

// ─── Helpers ───────────────────────────────────────────

const INVOICE_ATTACHMENT_EXTENSIONS = new Set([
	'.pdf', '.jpg', '.jpeg', '.png', '.xml', '.isdoc', '.tif', '.tiff',
]);

const INVOICE_ATTACHMENT_MIME_TYPES = new Set([
	'application/pdf',
	'application/xml',
	'text/xml',
	'image/jpeg',
	'image/png',
	'image/tiff',
]);

function isInvoiceAttachment(attachment) {
	const name = (attachment.filename || '').toLowerCase();
	const dotIndex = name.lastIndexOf('.');
	const extension = dotIndex >= 0 ? name.slice(dotIndex) : '';
	const mimeType = (attachment.mimeType || '').toLowerCase();

	return INVOICE_ATTACHMENT_EXTENSIONS.has(extension)
		|| INVOICE_ATTACHMENT_MIME_TYPES.has(mimeType);
}

// ─── Core Pipeline ─────────────────────────────────────

/**
 * @param {Awaited<ReturnType<typeof setup>>} svc
 * @returns {Promise<Array<{
 *   emailId: string, subject: string, success: boolean,
 *   uploadedCount?: number, uploadedNames?: string[], error?: string
 * }>>}
 */
async function processInvoices(svc) {
	const { cfg, trivi, email, storage, notification } = svc;
	console.log('=== Starting uploaded documents processing ===');
  const results = [];

  // 1. Fetch unread emails
  let emails;
  try {
    emails = await email.fetchUnreadEmails();
  } catch (err) {
    console.error(`[fatal] IMAP fetch failed: ${err.message}`);
    await notification.sendAlert(
      'IMAP connection failed',
      `Could not connect to ${cfg.email.host}:${cfg.email.port}\nError: ${err.message}`
    );
    throw err;
  }

  if (emails.length === 0) {
    console.log('No unread emails — nothing to process');
    return results;
  }

  // 2. Process each email independently (one failure doesn't block others)
  for (const msg of emails) {
    const result = {
      emailId: msg.emailId,
      subject: msg.subject,
      success: false,
    };

	  try {
      console.log(`[processing] "${msg.subject}"`);
		  const invoiceAttachments = msg.attachments.filter(isInvoiceAttachment);

		  if (invoiceAttachments.length === 0) {
			  console.log('[skip] No invoice-like attachment found');
			  result.error = 'No invoice attachment found';
        results.push(result);
        continue;
      }

		  const uploadResponses = [];

		  for (const attachment of invoiceAttachments) {
			  const uploadResponse = await trivi.uploadDocumentAttachment(attachment, {
				  subject: msg.subject,
				  from: msg.from,
				  receivedDate: msg.receivedDate.toISOString(),
        });
			uploadResponses.push(uploadResponse);
			console.log(`[ok] Uploaded attachment: ${attachment.filename}`);
      }

		  result.success = true;
		  result.uploadedCount = invoiceAttachments.length;
		  result.uploadedNames = invoiceAttachments.map((attachment) => attachment.filename);

		  // 2b. Archive to S3 for audit trail
		  try {
			  await storage.archiveEmail(
				  msg.emailId,
				  JSON.stringify({
					  subject: msg.subject,
					  from: msg.from,
					  date: msg.receivedDate.toISOString(),
			  uploadedAttachments: invoiceAttachments.map((attachment) => ({
				  filename: attachment.filename,
				  mimeType: attachment.mimeType,
				  sizeBytes: attachment.sizeBytes,
			  })),
			  triviUploadResponses: uploadResponses,
		  }, null, 2)
		);
	  } catch (error) {
		  console.warn(`[warn] S3 archive skipped after successful upload: ${error.message}`);
	  }

    } catch (error) {
      console.error(`[error] "${msg.subject}": ${error.message}`);
      result.error = error.message;
    }

	  // 3. Mark as read only when document upload succeeded
	  if (result.success) {
		  try {
			  await email.markAsRead(msg.emailId);
		  } catch (e) {
			  console.warn(`[warn] Failed to mark email ${msg.emailId} as read: ${e.message}`);
		  }
    }

    // 4. Cleanup temp attachment files
    for (const att of msg.attachments) {
      try { await fs.unlink(att.path); } catch { /* already gone */ }
    }

    results.push(result);
  }

  // 5. Send daily summary
  await sendSummary(results, notification);

  console.log('=== Daily processing complete ===');
  return results;
}

// ─── Notification ──────────────────────────────────────

async function sendSummary(results, notification) {
  const ok = results.filter(r => r.success);
	const fail = results.filter(r => !r.success && r.error !== 'No invoice attachment found');
	const skip = results.filter(r => r.error === 'No invoice attachment found');

  const lines = [
	  '📊 Diamondigital Documents Upload — Denní přehled',
    '────────────────────────────────────────',
    `Celkem e-mailů: ${results.length}`,
	  `✅ Úspěšně nahráno: ${ok.length}`,
    `⚠️  Chyby: ${fail.length}`,
	  `⏭️  Přeskočeno (bez přílohy faktury): ${skip.length}`,
  ];

  if (ok.length > 0) {
	  lines.push('', 'Nahrané dokumenty:');
    for (const r of ok) {
		lines.push(`  • ${r.uploadedCount || 0} příloha/y ← "${r.subject}"`);
    }
  }

  if (fail.length > 0) {
    lines.push('', '❌ Chyby:');
    for (const r of fail) {
      lines.push(`  • "${r.subject}": ${r.error}`);
    }
    // Escalate failures to admin
    await notification.sendAlert(
		`${fail.length} document upload(s) failed`,
      fail.map(r => `- ${r.subject}: ${r.error}`).join('\n')
    );
  }

  await notification.sendSummary(lines.join('\n'));
}

// ─── Lambda Handler ────────────────────────────────────

/**
 * AWS Lambda entry point.
 * @param {any} event
 * @param {import('aws-lambda').Context} context
 */
export const handler = async (event, context) => {
  console.log(`[lambda] Invocation: ${context.awsRequestId}`);

  // Warm-start: reuse service instances across invocations
  if (!services) {
    services = await setup();
  }

  let results;
  try {
    results = await processInvoices(services);
  } catch (error) {
    console.error(`[lambda] Fatal error: ${error.message}`);
    // Re-throw to trigger Lambda retry / DLQ
    throw error;
  }

  const ok = results.filter(r => r.success).length;
  const fail = results.filter(r => !r.success).length;

  console.log(`[lambda] Done: ${results.length} processed, ${ok} ok, ${fail} failed`);

  return {
    statusCode: fail > 0 ? 207 : 200,
    body: JSON.stringify({
      processed: results.length,
      successful: ok,
      failed: fail,
    }),
  };
};
