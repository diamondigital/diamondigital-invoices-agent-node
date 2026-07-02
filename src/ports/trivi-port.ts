import type { Attachment, UploadMetadata, UploadResult } from '../domain/types.js';
export interface TriviPort {
  uploadDocumentAttachment(attachment: Attachment, metadata?: UploadMetadata): Promise<UploadResult>;
}
