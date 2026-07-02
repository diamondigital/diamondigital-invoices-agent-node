// src/image-conversion.js — Transcode TRIVI-unsupported image formats to PNG.
// TRIVI rejects HEIC/HEIF (iPhone photos), WebP, and TIFF. We convert them to
// PNG before the attachment is written to disk, so the classifier, the TRIVI
// upload, and the S3 archive all operate on one canonical PNG.
//
// heic-convert only *reads* HEIC (and is pure JS/wasm — works anywhere);
// sharp's prebuilt binary lacks libheif but reads WebP and TIFF natively.
// So each library is used only where it is reliable.
import convertHeic from 'heic-convert';
import sharp from 'sharp';

const CONVERT_EXTS = new Set(['.heic', '.heif', '.webp', '.tif', '.tiff']);
const CONVERT_MIMES = new Set(['image/heic', 'image/heif', 'image/webp', 'image/tiff']);

function extOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

/**
 * True if the attachment is a TRIVI-unsupported image we must transcode to PNG.
 * @param {string} filename
 * @param {string} [mimeType]
 */
export function needsPngConversion(filename, mimeType) {
  const ext = extOf(filename || '');
  const mime = (mimeType || '').toLowerCase();
  return CONVERT_EXTS.has(ext) || CONVERT_MIMES.has(mime);
}

/**
 * Transcode an image buffer to PNG. HEIC/HEIF (by ext or MIME) go through
 * heic-convert; everything else (WebP, TIFF) through sharp.
 * @param {Buffer} buffer
 * @param {string} ext lowercase extension incl. dot (e.g. '.webp')
 * @param {string} [mimeType]
 * @returns {Promise<Buffer>}
 */
export async function toPng(buffer, ext, mimeType) {
  const mime = (mimeType || '').toLowerCase();
  if (ext === '.heic' || ext === '.heif' || mime === 'image/heic' || mime === 'image/heif') {
    const out = await convertHeic({ buffer, format: 'PNG' });
    return Buffer.from(out);
  }
  return sharp(buffer).png().toBuffer();
}

/** Swap a filename's extension for `.png` (adds .png if there is no extension). */
export function toPngFilename(filename) {
  const dot = filename.lastIndexOf('.');
  return (dot >= 0 ? filename.slice(0, dot) : filename) + '.png';
}
