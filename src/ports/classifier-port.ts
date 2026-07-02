import type { Attachment, Classification } from '../domain/types.js';
export interface ClassifyContext {
  subject?: string;
  from?: string;
}
export interface ClassifierPort {
  classifyAttachment(attachment: Attachment, context?: ClassifyContext): Promise<Classification>;
}
