import convertHeic from 'heic-convert';
import sharp from 'sharp';

const CONVERT_EXTS = new Set(['.heic', '.heif', '.webp', '.tif', '.tiff']);
const CONVERT_MIMES = new Set(['image/heic', 'image/heif', 'image/webp', 'image/tiff']);

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

export function needsPngConversion(filename: string, mimeType?: string): boolean {
  const ext = extOf(filename || '');
  const mime = (mimeType || '').toLowerCase();
  return CONVERT_EXTS.has(ext) || CONVERT_MIMES.has(mime);
}

export async function toPng(buffer: Buffer, ext: string, mimeType?: string): Promise<Buffer> {
  const mime = (mimeType || '').toLowerCase();
  if (ext === '.heic' || ext === '.heif' || mime === 'image/heic' || mime === 'image/heif') {
    const out = await convertHeic({ buffer, format: 'PNG' });
    return Buffer.from(out);
  }
  return sharp(buffer).png().toBuffer();
}

export function toPngFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return (dot >= 0 ? filename.slice(0, dot) : filename) + '.png';
}
