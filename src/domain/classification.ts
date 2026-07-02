import type { Classification, PaymentMethod } from './types.js';
export function guessMimeType(filename: string, fallback?: string): string {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.heic': return 'image/heic';
    case '.heif': return 'image/heif';
    case '.tif':
    case '.tiff': return 'image/tiff';
    default: return fallback || 'application/octet-stream';
  }
}
export function parseClassification(raw: unknown): Classification {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        isAccountingDocument: Boolean(parsed.isAccountingDocument),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
        docType: (parsed.docType as string) || 'other',
        paymentMethod: ((parsed.paymentMethod as PaymentMethod) || 'unknown'),
        reason: (parsed.reason as string) || '',
      };
    } catch {
    }
  }
  return { isAccountingDocument: false, confidence: 0, docType: 'other', paymentMethod: 'unknown', reason: 'classification_unavailable' };
}
