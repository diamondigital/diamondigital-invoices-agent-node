import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { needsPngConversion, toPng, toPngFilename } from '../lib/image.js';

export const DEFAULT_PROCESSED_LABEL = 'TRIVI';

const MAX_ZIP_ENTRIES = 50;
const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024;

const EXT_MIME = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.xml': 'application/xml',
  '.isdoc': 'application/xml',
};

function inferMime(filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  return EXT_MIME[ext] || 'application/octet-stream';
}

const DOC_MAGIC = {
  '.pdf': Buffer.from('%PDF'),
  '.xml': Buffer.from('<?xml'),
  '.isdoc': Buffer.from('<?xml'),
};

function normalizeDocumentContent(data, filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  const magic = DOC_MAGIC[ext];
  if (!magic) return data;
  if (data.length >= magic.length && data.subarray(0, magic.length).equals(magic)) return data;
  const idx = data.indexOf(magic);
  if (idx > 0) {
    console.warn(`[warn] Stripped ${idx} leading byte(s) before ${magic} marker in "${filename}"`);
    return data.subarray(idx);
  }
  return data;
}

function uniqueName(name, usedNames) {
  let candidate = name;
  let i = 1;
  while (usedNames.has(candidate)) {
    candidate = `${i}_${name}`;
    i += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

async function writeAttachmentRecord(rawBuffer, rawName, mimeType, destDir, usedNames) {
  let data = rawBuffer;
  let baseName = path.basename(rawName);
  let outMime = mimeType;

  if (needsPngConversion(baseName, mimeType)) {
    const dot = baseName.lastIndexOf('.');
    const ext = dot >= 0 ? baseName.slice(dot).toLowerCase() : '';
    try {
      data = await toPng(rawBuffer, ext, mimeType);
      baseName = toPngFilename(baseName);
      outMime = 'image/png';
      console.log(`[email] Converted "${rawName}" → "${baseName}" (TRIVI-safe PNG)`);
    } catch (err) {
      console.warn(`[warn] Could not convert "${rawName}" to PNG — skipping: ${err.message}`);
      return null;
    }
  }

  const filename = uniqueName(baseName, usedNames);
  const filePath = path.join(destDir, filename);

  if (!path.resolve(destDir, filename).startsWith(path.resolve(destDir) + path.sep)) {
    console.warn(`[warn] Skipping attachment that resolves outside destDir: "${rawName}"`);
    return null;
  }

  const content = normalizeDocumentContent(data, filename);
  try {
    await fs.writeFile(filePath, content);
  } catch (err) {
    console.warn(`[warn] Could not write attachment "${rawName}": ${err.message}`);
    return null;
  }
  return { filename, path: filePath, mimeType: outMime || inferMime(filename), sizeBytes: content.length };
}

export function isZipAttachment(att) {
  const name = (att.filename || '').toLowerCase();
  const mime = (att.contentType || att.mimeType || '').toLowerCase();
  return (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    name.endsWith('.zip')
  );
}

export async function extractZipEntries(buffer, destDir, usedNames = new Set()) {
  const records = [];
  let entries;
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch (err) {
    console.warn(`[warn] Could not open zip attachment: ${err.message}`);
    return records;
  }

  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (records.length >= MAX_ZIP_ENTRIES) {
      console.warn(`[warn] Zip entry limit (${MAX_ZIP_ENTRIES}) reached — skipping remaining entries`);
      break;
    }
    const safeName = path.basename(entry.entryName);
    if (!safeName || safeName === '.' || safeName === '..') {
      console.warn(`[warn] Skipping unsafe zip entry name "${entry.entryName}"`);
      continue;
    }

    const entrySize = entry.header.size;
    if (totalBytes + entrySize > MAX_ZIP_TOTAL_BYTES) {
      console.warn('[warn] Zip uncompressed size limit reached — skipping remaining entries');
      break;
    }
    totalBytes += entrySize;

    let data;
    try {
      data = entry.getData();
    } catch (err) {
      console.warn(`[warn] Skipping unreadable zip entry "${entry.entryName}": ${err.message}`);
      continue;
    }

    const rec = await writeAttachmentRecord(data, safeName, inferMime(safeName), destDir, usedNames);
    if (rec) records.push(rec);
  }

  return records;
}

export async function materializeAttachments(parsedAttachments, destDir) {
  const attachments = [];
  const usedNames = new Set();
  for (const att of parsedAttachments) {
    if (!att.filename) continue;

    if (isZipAttachment(att)) {
      console.log(`[email] Expanding zip attachment: ${att.filename}`);
      const extracted = await extractZipEntries(att.content, destDir, usedNames);
      console.log(`[email] Extracted ${extracted.length} file(s) from ${att.filename}`);
      attachments.push(...extracted);
      continue;
    }

    const rec = await writeAttachmentRecord(att.content, att.filename, att.contentType, destDir, usedNames);
    if (rec) attachments.push(rec);
  }
  return attachments;
}
