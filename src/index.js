// src/index.js — AWS Lambda handler: Diamondigital Documents Upload Agent
import { loadConfig } from './config.js';
import { TriviAuth } from './trivi-auth.js';
import { TriviService } from './trivi-service.js';
import { EmailService } from './email-service.js';
import { StorageService } from './storage-service.js';
import { NotificationService } from './notification-service.js';
import { DocumentClassifier } from './document-classifier.js';
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

  // Mistral classifier gates uploads; disabled (with a warning) if no API key.
  const classifier = cfg.mistral.apiKey
    ? new DocumentClassifier(cfg.mistral)
    : null;
  if (!classifier) {
    console.warn('[setup] MISTRAL_API_KEY missing — classification disabled, all invoice-like attachments will be uploaded');
  }

  // Wrap critical TRIVI calls with retry
	trivi.uploadDocumentAttachment = withRetry(trivi.uploadDocumentAttachment.bind(trivi), {
    maxAttempts: 3, baseDelayMs: 1000,
	});

  console.log('[setup] Services initialized');
	return { cfg, trivi, email, storage, notification, classifier };
}

// ─── Helpers ───────────────────────────────────────────

const INVOICE_ATTACHMENT_EXTENSIONS = new Set([
	'.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.xml', '.isdoc', '.tif', '.tiff',
]);

const INVOICE_ATTACHMENT_MIME_TYPES = new Set([
	'application/pdf',
	'application/xml',
	'text/xml',
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/heic',
	'image/heif',
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
 *   uploadedCount?: number, uploadedNames?: string[],
 *   skipped?: boolean, skipReason?: string,
 *   classifications?: Array<{filename:string, isAccountingDocument:boolean, confidence:number, docType:string, uploaded:boolean}>,
 *   error?: string
 * }>>}
 */
async function processInvoices(svc) {
	const { cfg, trivi, email, storage, notification, classifier } = svc;
	console.log('=== Starting uploaded documents processing ===');
  const results = [];

  // 1. Fetch not-yet-processed emails (those without the processed label)
  let emails;
  try {
    emails = await email.fetchUnprocessedEmails();
  } catch (err) {
    console.error(`[fatal] IMAP fetch failed: ${err.message}`);
    await notification.sendAlert(
      'IMAP connection failed',
      `Could not connect to ${cfg.email.host}:${cfg.email.port}\nError: ${err.message}`
    );
    throw err;
  }

  if (emails.length === 0) {
    console.log('No unprocessed emails — nothing to process');
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

		  const uploadResponses = [];
		  const uploadedNames = [];
		  const classifications = [];

		  for (const attachment of invoiceAttachments) {
			  // Classify the attachment content (a logo and a real invoice both
			  // arrive as image/pdf — only the LLM can tell them apart).
			  let cls = { isAccountingDocument: true, confidence: 1, docType: 'unknown', reason: 'classifier-disabled' };
			  if (classifier) {
				  cls = await classifier.classifyAttachment(attachment, { subject: msg.subject, from: msg.from });
				  console.log(`[classify] ${attachment.filename}: doc=${cls.isAccountingDocument} type=${cls.docType} conf=${cls.confidence} — ${cls.reason}`);
			  }

			  const qualifies = cls.isAccountingDocument && cls.confidence >= cfg.mistral.uploadThreshold;
			  if (!qualifies) {
				  console.log(`[skip] Not an accounting document (conf ${cls.confidence} < ${cfg.mistral.uploadThreshold}): ${attachment.filename}`);
				  classifications.push({ filename: attachment.filename, ...cls, uploaded: false });
				  continue;
			  }

			  const uploadResponse = await trivi.uploadDocumentAttachment(attachment, {
				  subject: msg.subject,
				  from: msg.from,
				  receivedDate: msg.receivedDate.toISOString(),
				  classification: cls,
        });
			uploadResponses.push(uploadResponse);
			uploadedNames.push(attachment.filename);
			classifications.push({ filename: attachment.filename, ...cls, uploaded: true });
			console.log(`[ok] Uploaded attachment: ${attachment.filename}`);
      }

		  result.classifications = classifications;

		  if (uploadedNames.length > 0) {
			  result.success = true;
			  result.uploadedCount = uploadedNames.length;
			  result.uploadedNames = uploadedNames;

			  // 2b. Archive to S3 for audit trail
			  try {
				  await storage.archiveEmail(
					  msg.emailId,
					  JSON.stringify({
						  subject: msg.subject,
						  from: msg.from,
						  date: msg.receivedDate.toISOString(),
				  classifications,
				  triviUploadResponses: uploadResponses,
			  }, null, 2)
			);
		  } catch (error) {
			  console.warn(`[warn] S3 archive skipped after successful upload: ${error.message}`);
		  }
		  } else {
			  // Examined fully, nothing qualified as an accounting document.
			  result.skipped = true;
			  result.skipReason = invoiceAttachments.length === 0
				  ? 'no invoice-like attachment'
				  : 'no attachment classified as accounting document';
			  console.log(`[skip] "${msg.subject}": ${result.skipReason}`);
		  }

    } catch (error) {
      console.error(`[error] "${msg.subject}": ${error.message}`);
      result.error = error.message;
    }

	  // 3. Email lifecycle (Seznam has no labels → move between folders):
	  //    uploaded → processed folder; examined-no-doc → skipped folder;
	  //    error → leave in INBOX so the next run retries it.
	  try {
		  if (result.success) {
			  await email.markAsProcessed(msg.emailId);
		  } else if (result.skipped) {
			  await email.markAsSkipped(msg.emailId);
		  }
	  } catch (e) {
		  console.warn(`[warn] Failed to move email ${msg.emailId}: ${e.message}`);
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
	const skip = results.filter(r => !r.success && r.skipped);
	const fail = results.filter(r => !r.success && !r.skipped);

  const lines = [
	  '📊 Diamondigital Documents Upload — Denní přehled',
    '────────────────────────────────────────',
    `Celkem e-mailů: ${results.length}`,
	  `✅ Úspěšně nahráno: ${ok.length}`,
    `⚠️  Chyby: ${fail.length}`,
	  `⏭️  Přeskočeno (není účetní doklad): ${skip.length}`,
  ];

  if (ok.length > 0) {
	  lines.push('', 'Nahrané dokumenty:');
    for (const r of ok) {
		const detail = (r.classifications || [])
			.filter(c => c.uploaded)
			.map(c => `${c.docType} ${Math.round((c.confidence || 0) * 100)}%`)
			.join(', ');
		lines.push(`  • ${r.uploadedCount || 0} příloha/y ← "${r.subject}"${detail ? ` [${detail}]` : ''}`);
    }
  }

  if (skip.length > 0) {
	  lines.push('', '⏭️  Přeskočené e-maily:');
    for (const r of skip) {
		// Show borderline attachments (classified as doc but below threshold)
		const borderline = (r.classifications || [])
			.filter(c => c.isAccountingDocument && !c.uploaded)
			.map(c => `${c.filename}: ${c.docType} ${Math.round((c.confidence || 0) * 100)}%`);
		lines.push(`  • "${r.subject}" — ${r.skipReason}`);
		for (const b of borderline) lines.push(`      ⚠ možný doklad pod prahem: ${b}`);
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

  // Test hook: invoke with { "sentryTest": true } to force an error and verify
  // Sentry error capture. Guarded by an explicit flag so it never fires on
  // scheduled runs; throws before any config load / IMAP / TRIVI work.
  if (event?.sentryTest) {
    throw new Error('Sentry test error — verifying error capture');
  }

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
  // Skipped (no accounting document) is an expected outcome, not a failure —
  // only genuine errors (left in INBOX for retry) count as failed.
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
