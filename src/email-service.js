// src/email-service.js — IMAP client for Seznam: fetch unread emails, mark read
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export class EmailService {
  /**
   * @param {{ host: string, port: number, secure: boolean, user: string, password: string }} config
   */
  constructor(config) {
    this.config = config;
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
   * Fetch all unread emails from INBOX.
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
  async fetchUnreadEmails() {
    const client = this.#createClient();
    const results = [];
	  let connected = false;

    try {
      await client.connect();
		connected = true;
      console.log('[email] Connected to IMAP server');

      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch(
          { unseen: true },
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

    console.log(`[email] Fetched ${results.length} unread email(s)`);
    return results;
  }

  /**
   * Mark an email as read by UID.
   * @param {string} emailId
   */
  async markAsRead(emailId) {
    const client = this.#createClient();
	  let connected = false;
    try {
      await client.connect();
		connected = true;
      const lock = await client.getMailboxLock('INBOX');
      try {
        await client.messageFlagsAdd({ uid: emailId }, ['\\Seen']);
        console.log(`[email] Marked ${emailId} as read`);
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
