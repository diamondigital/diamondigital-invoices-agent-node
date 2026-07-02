import type { EmailMessage } from '../domain/types.js';
export interface EmailPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  fetchUnprocessedEmails(): Promise<EmailMessage[]>;
  markAsProcessed(emailId: string): Promise<void>;
  markAsSkipped(emailId: string): Promise<void>;
}
