import fs from 'node:fs/promises';
import { isInvoiceAttachment } from '../domain/attachment-filter.js';
import type { Classification, ClassificationResult, EmailMessage, ProcessResult, UploadResult } from '../domain/types.js';
import type { Services } from '../ports/services.js';
import { sendSummary } from './summary.js';

type ClassifyOutcome = Pick<Classification, 'isAccountingDocument' | 'confidence' | 'docType' | 'reason'> &
  Partial<Pick<Classification, 'paymentMethod'>>;

export async function processEmail(msg: EmailMessage, svc: Services): Promise<ProcessResult> {
  const { cfg, trivi, email, storage, classifier } = svc;

  const result: ProcessResult = {
    emailId: msg.emailId,
    subject: msg.subject,
    success: false,
  };

  try {
    console.log(`[processing] "${msg.subject}"`);
    const invoiceAttachments = msg.attachments.filter(isInvoiceAttachment);

    const uploadResponses: UploadResult[] = [];
    const uploadedNames: string[] = [];
    const classifications: ClassificationResult[] = [];

    for (const attachment of invoiceAttachments) {
      let cls: ClassifyOutcome = { isAccountingDocument: true, confidence: 1, docType: 'unknown', reason: 'classifier-disabled' };
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
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[warn] S3 archive skipped after successful upload: ${message}`);
      }
    } else {
      result.skipped = true;
      result.skipReason = invoiceAttachments.length === 0
        ? 'no invoice-like attachment'
        : 'no attachment classified as accounting document';
      console.log(`[skip] "${msg.subject}": ${result.skipReason}`);
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] "${msg.subject}": ${message}`);
    result.error = message;
  }

  try {
    if (result.success) {
      await email.markAsProcessed(msg.emailId);
    } else if (result.skipped) {
      await email.markAsSkipped(msg.emailId);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[warn] Failed to move email ${msg.emailId}: ${message}`);
  }

  for (const att of msg.attachments) {
    try { await fs.unlink(att.path); } catch { }
  }

  return result;
}

export async function processInvoices(svc: Services): Promise<ProcessResult[]> {
  const { cfg, email, notification } = svc;
  console.log('=== Starting uploaded documents processing ===');
  const results: ProcessResult[] = [];

  try {
    let emails: EmailMessage[];
    try {
      await email.connect();
      emails = await email.fetchUnprocessedEmails();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[fatal] IMAP fetch failed: ${message}`);
      await notification.sendAlert(
        'IMAP connection failed',
        `Could not connect to ${cfg.email.host}:${cfg.email.port}\nError: ${message}`
      );
      throw err;
    }

    if (emails.length === 0) {
      console.log('No unprocessed emails — nothing to process');
      return results;
    }

    for (const msg of emails) {
      const result = await processEmail(msg, svc);
      results.push(result);
    }

    await sendSummary(results, notification);

    console.log('=== Daily processing complete ===');
    return results;
  } finally {
    await email.disconnect();
  }
}
