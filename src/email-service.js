// src/email-service.js — IMAP client for Seznam: fetch INBOX, move processed to a folder
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';

// Default IMAP folder used as the "processed" marker. Overridable via
// EMAIL_PROCESSED_LABEL. Seznam IMAP does not support custom keywords/labels,
// so a successfully-processed email is MOVED out of INBOX into this folder.
// Anything left in INBOX is therefore "unprocessed" and retried next run.
export const DEFAULT_PROCESSED_LABEL = 'TRIVI';

// Zip-attachment expansion safeguards (see docs spec 2026-07-01).
const MAX_ZIP_ENTRIES = 50;
const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024;

const EXT_MIME = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.xml': 'application/xml',
  '.isdoc': 'application/xml',
};

function inferMime(filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  return EXT_MIME[ext] || 'application/octet-stream';
}

// Return `name`, or `${i}_name` for the first i that isn't already taken.
// Mutates `usedNames` with the chosen result.
function uniqueName(name, usedNames) {
  let candidate = name;
  let i = 1;
  while (usedNames.has(candidate)) {
    candidate = `${i}_${name}`;
    i += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * True if an attachment is a zip, by MIME (application/zip,
 * application/x-zip-compressed) or by a .zip filename (Seznam sometimes sends
 * zips as application/octet-stream).
 * @param {{filename?:string, contentType?:string, mimeType?:string}} att
 */
export function isZipAttachment(att) {
  const name = (att.filename || '').toLowerCase();
  const mime = (att.contentType || att.mimeType || '').toLowerCase();
  return (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    name.endsWith('.zip')
  );
}

/**
 * Unpack a zip buffer into destDir. Best-effort: a corrupt/unreadable zip or
 * entry is logged and skipped rather than thrown. Directory entries are
 * ignored; entry names are flattened to basename (zip-slip guard); count and
 * total uncompressed size are capped.
 * @param {Buffer} buffer
 * @param {string} destDir
 * @param {Set<string>} [usedNames]
 * @returns {Promise<Array<{filename:string, path:string, mimeType:string, sizeBytes:number}>>}
 */
export async function extractZipEntries(buffer, destDir, usedNames = new Set()) {
  const records = [];
  let entries;
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch (err) {
    console.warn(`[warn] Could not open zip attachment: ${err.message}`);
    return records;
  }

  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (records.length >= MAX_ZIP_ENTRIES) {
      console.warn(`[warn] Zip entry limit (${MAX_ZIP_ENTRIES}) reached — skipping remaining entries`);
      break;
    }
    const safeName = path.basename(entry.entryName);
    if (!safeName) continue;

    let data;
    try {
      data = entry.getData(); // throws on encrypted/corrupt entries
    } catch (err) {
      console.warn(`[warn] Skipping unreadable zip entry "${entry.entryName}": ${err.message}`);
      continue;
    }

    totalBytes += data.length;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      console.warn('[warn] Zip uncompressed size limit reached — skipping remaining entries');
      break;
    }

    const filename = uniqueName(safeName, usedNames);
    const filePath = path.join(destDir, filename);
    await fs.writeFile(filePath, data);
    records.push({ filename, path: filePath, mimeType: inferMime(filename), sizeBytes: data.length });
  }

  return records;
}

export class EmailService {
  /**
   * @param {{ host: string, port: number, secure: boolean, user: string, password: string, processedLabel?: string, skippedFolder?: string }} config
   */
  constructor(config) {
    this.config = config;
    this.processedFolder = config.processedLabel || DEFAULT_PROCESSED_LABEL;
    this.skippedFolder = config.skippedFolder || 'Bez dokladu';
  }

  #createClient() {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
    });
  }

  /**
   * Fetch all emails currently in INBOX. Processed emails are moved out to
   * the processed folder, so whatever remains in INBOX is unprocessed.
   * @returns {Promise<Array<{
   *   emailId: string,
   *   subject: string,
   *   from: string,
   *   receivedDate: Date,
   *   bodyText: string,
   *   bodyHtml?: string,
   *   attachments: Array<{filename:string, path:string, mimeType:string, sizeBytes:number}>
   * }>>}
   */
  async fetchUnprocessedEmails() {
    const client = this.#createClient();
    const results = [];
	  let connected = false;

    try {
      await client.connect();
		connected = true;
      console.log('[email] Connected to IMAP server');

      const lock = await client.getMailboxLock('INBOX');
      try {
        // Seznam rejects "FETCH 1:*" on an empty mailbox — guard explicitly.
        if (!client.mailbox || client.mailbox.exists === 0) {
          console.log('[email] INBOX is empty');
          return results;
        }
        for await (const msg of client.fetch(
          { all: true },
          { uid: true, envelope: true, source: true }
        )) {
          const parsed = await simpleParser(msg.source);
          const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'invoice-'));

          const attachments = [];
          for (const att of parsed.attachments || []) {
            if (!att.filename) continue;
            const filePath = path.join(tempDir, att.filename);
            await fs.writeFile(filePath, att.content);
            attachments.push({
              filename: att.filename,
              path: filePath,
              mimeType: att.contentType,
              sizeBytes: att.size,
            });
          }

          results.push({
            emailId: String(msg.uid),
            subject: parsed.subject || '(bez předmětu)',
            from: parsed.from?.text || '',
            receivedDate: parsed.date || new Date(),
            bodyText: parsed.text || '',
            bodyHtml: parsed.html || undefined,
            attachments,
          });
        }
      } finally {
        lock.release();
      }
    } finally {
		if (connected) {
        try {
          await client.logout();
        } catch (err) {
          console.warn(`[email] IMAP logout skipped: ${err.message}`);
        }
	  }
	}

    console.log(`[email] Fetched ${results.length} unprocessed email(s)`);
    return results;
  }

  /**
   * Mark an email as processed (accounting document uploaded) by moving it
   * out of INBOX into the processed folder.
   * @param {string} emailId
   */
  async markAsProcessed(emailId) {
    return this.#moveToFolder(emailId, this.processedFolder);
  }

  /**
   * Mark an email as examined-but-skipped (no accounting document found) by
   * moving it into the skipped folder, so it is not re-classified next run.
   * @param {string} emailId
   */
  async markAsSkipped(emailId) {
    return this.#moveToFolder(emailId, this.skippedFolder);
  }

  /**
   * Move an email out of INBOX into a destination folder (Seznam IMAP has no
   * custom labels, so a folder move is the "processed" marker). The folder is
   * created on first use if it does not exist.
   * @param {string} emailId
   * @param {string} folder
   */
  async #moveToFolder(emailId, folder) {
    const client = this.#createClient();
	  let connected = false;
    try {
      await client.connect();
		connected = true;
      // Ensure the folder exists (Seznam returns an opaque "Command failed"
      // when creating an existing mailbox, so check first).
      const exists = await client.list()
        .then((boxes) => boxes.some((b) => b.path === folder))
        .catch(() => false);
      if (!exists) {
        try {
          await client.mailboxCreate(folder);
          console.log(`[email] Created folder "${folder}"`);
        } catch (err) {
          console.warn(`[email] Could not create folder "${folder}": ${err.message}`);
        }
      }

      const lock = await client.getMailboxLock('INBOX');
      try {
        await client.messageMove({ uid: emailId }, folder);
        console.log(`[email] Moved ${emailId} to "${folder}"`);
      } finally {
        lock.release();
      }
    } finally {
		if (connected) {
        try {
          await client.logout();
        } catch (err) {
          console.warn(`[email] IMAP logout skipped: ${err.message}`);
        }
	  }
    }
  }
}
