import type { Attachment } from './types.js';
export const INVOICE_ATTACHMENT_EXTENSIONS = new Set<string>([
  '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.xml', '.isdoc', '.tif', '.tiff',
]);
export const INVOICE_ATTACHMENT_MIME_TYPES = new Set<string>([
  'application/pdf', 'application/xml', 'text/xml', 'image/jpeg', 'image/png',
  'image/webp', 'image/heic', 'image/heif', 'image/tiff',
]);
export function isInvoiceAttachment(attachment: Pick<Attachment, 'filename' | 'mimeType'>): boolean {
  const name = (attachment.filename || '').toLowerCase();
  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex >= 0 ? name.slice(dotIndex) : '';
  const mimeType = (attachment.mimeType || '').toLowerCase();
  return INVOICE_ATTACHMENT_EXTENSIONS.has(extension) || INVOICE_ATTACHMENT_MIME_TYPES.has(mimeType);
}
