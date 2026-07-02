import fs from 'node:fs/promises';
import { isInvoiceAttachment } from './attachment-filter.js';
import { sendSummary } from './summary.js';

export async function processInvoices(svc) {
	const { cfg, trivi, email, storage, notification, classifier } = svc;
	console.log('=== Starting uploaded documents processing ===');
  const results = [];

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

	  try {
		  if (result.success) {
			  await email.markAsProcessed(msg.emailId);
		  } else if (result.skipped) {
			  await email.markAsSkipped(msg.emailId);
		  }
	  } catch (e) {
		  console.warn(`[warn] Failed to move email ${msg.emailId}: ${e.message}`);
	  }

    for (const att of msg.attachments) {
      try { await fs.unlink(att.path); } catch {}
    }

    results.push(result);
  }

  await sendSummary(results, notification);

  console.log('=== Daily processing complete ===');
  return results;
}
