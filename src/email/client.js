import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { materializeAttachments, DEFAULT_PROCESSED_LABEL } from './materialize.js';

export class EmailService {
  constructor(config) {
    this.config = config;
    this.processedFolder = config.processedLabel || DEFAULT_PROCESSED_LABEL;
    this.skippedFolder = config.skippedFolder || 'Bez dokladu';
    this.clientFactory = config.clientFactory || (() => this.#createClient());
    this.client = null;
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

  async connect() {
    if (this.client) return;

    const client = this.clientFactory();
    await client.connect();
    this.client = client;
    console.log('[email] Connected to IMAP server');

    await this.#ensureFolders();
  }

  async #ensureFolders() {
    let existing = new Set();
    try {
      const boxes = await this.client.list();
      existing = new Set(boxes.map((b) => b.path));
    } catch (err) {
      console.warn(`[email] Could not list folders: ${err.message}`);
    }

    for (const folder of [this.processedFolder, this.skippedFolder]) {
      if (existing.has(folder)) continue;
      try {
        await this.client.mailboxCreate(folder);
        console.log(`[email] Created folder "${folder}"`);
      } catch (err) {
        console.warn(`[email] Could not create folder "${folder}": ${err.message}`);
      }
    }
  }

  async disconnect() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      await client.logout();
    } catch (err) {
      console.warn(`[email] IMAP logout skipped: ${err.message}`);
    }
  }

  async fetchUnprocessedEmails() {
    const client = this.client;
    const results = [];

    const lock = await client.getMailboxLock('INBOX');
    try {
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

        const attachments = await materializeAttachments(parsed.attachments || [], tempDir);

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

    console.log(`[email] Fetched ${results.length} unprocessed email(s)`);
    return results;
  }

  async markAsProcessed(emailId) {
    return this.#moveToFolder(emailId, this.processedFolder);
  }

  async markAsSkipped(emailId) {
    return this.#moveToFolder(emailId, this.skippedFolder);
  }

  async #moveToFolder(emailId, folder) {
    const client = this.client;
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageMove({ uid: emailId }, folder);
      console.log(`[email] Moved ${emailId} to "${folder}"`);
    } finally {
      lock.release();
    }
  }
}
