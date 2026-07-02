import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { materializeAttachments, DEFAULT_PROCESSED_LABEL } from './materialize.js';
import type { EmailConfig, EmailMessage } from '../../domain/types.js';
import type { EmailPort } from '../../ports/email-port.js';

export interface ImapFlowMailboxLock {
  release(): void;
}

export interface ImapFlowListEntry {
  path: string;
}

export interface ImapFlowFetchMessage {
  uid: number | string;
  source: Buffer;
}

export interface ImapFlowLike {
  mailbox: { exists: number } | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<ImapFlowListEntry[]>;
  mailboxCreate(path: string): Promise<unknown>;
  getMailboxLock(path: string): Promise<ImapFlowMailboxLock>;
  fetch(
    range: { all: true },
    query: { uid: true; envelope: true; source: true },
  ): AsyncIterable<ImapFlowFetchMessage>;
  messageMove(range: { uid: string }, destination: string): Promise<unknown>;
}

export type ImapEmailAdapterConfig = EmailConfig & { clientFactory?: () => ImapFlowLike };

export class ImapEmailAdapter implements EmailPort {
  config: ImapEmailAdapterConfig;
  processedFolder: string;
  skippedFolder: string;
  clientFactory: () => ImapFlowLike;
  client: ImapFlowLike | null;

  constructor(config: ImapEmailAdapterConfig) {
    this.config = config;
    this.processedFolder = config.processedLabel || DEFAULT_PROCESSED_LABEL;
    this.skippedFolder = config.skippedFolder || 'Bez dokladu';
    this.clientFactory = config.clientFactory || (() => this.#createClient());
    this.client = null;
  }

  #createClient(): ImapFlowLike {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
    }) as unknown as ImapFlowLike;
  }

  async connect(): Promise<void> {
    if (this.client) return;

    const client = this.clientFactory();
    await client.connect();
    this.client = client;
    console.log('[email] Connected to IMAP server');

    await this.#ensureFolders();
  }

  async #ensureFolders(): Promise<void> {
    const client = this.client!;
    let existing = new Set<string>();
    try {
      const boxes = await client.list();
      existing = new Set(boxes.map((b) => b.path));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[email] Could not list folders: ${message}`);
    }

    for (const folder of [this.processedFolder, this.skippedFolder]) {
      if (existing.has(folder)) continue;
      try {
        await client.mailboxCreate(folder);
        console.log(`[email] Created folder "${folder}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[email] Could not create folder "${folder}": ${message}`);
      }
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      await client.logout();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[email] IMAP logout skipped: ${message}`);
    }
  }

  async fetchUnprocessedEmails(): Promise<EmailMessage[]> {
    const client = this.client!;
    const results: EmailMessage[] = [];

    const lock = await client.getMailboxLock('INBOX');
    try {
      if (!client.mailbox || client.mailbox.exists === 0) {
        console.log('[email] INBOX is empty');
        return results;
      }
      for await (const msg of client.fetch(
        { all: true },
        { uid: true, envelope: true, source: true },
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

  async markAsProcessed(emailId: string): Promise<void> {
    return this.#moveToFolder(emailId, this.processedFolder);
  }

  async markAsSkipped(emailId: string): Promise<void> {
    return this.#moveToFolder(emailId, this.skippedFolder);
  }

  async #moveToFolder(emailId: string, folder: string): Promise<void> {
    const client = this.client!;
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageMove({ uid: emailId }, folder);
      console.log(`[email] Moved ${emailId} to "${folder}"`);
    } finally {
      lock.release();
    }
  }
}
