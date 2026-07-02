import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { needsPngConversion, toPng, toPngFilename } from './image.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function isPng(buf) {
  return buf.length >= 4 && buf[0] === 0x89
    && buf.subarray(1, 4).toString('latin1') === 'PNG';
}

async function makeImage(format) {
  const img = sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 128, b: 255 } },
  });
  return format === 'webp' ? img.webp().toBuffer() : img.tiff().toBuffer();
}

test('needsPngConversion: true for TRIVI-unsupported images', () => {
  assert.equal(needsPngConversion('photo.heic', ''), true);
  assert.equal(needsPngConversion('photo.HEIF', ''), true);
  assert.equal(needsPngConversion('scan.webp', ''), true);
  assert.equal(needsPngConversion('scan.tif', ''), true);
  assert.equal(needsPngConversion('scan.tiff', ''), true);
  assert.equal(needsPngConversion('noext', 'image/webp'), true); // by MIME
});

test('needsPngConversion: false for formats TRIVI accepts', () => {
  assert.equal(needsPngConversion('doc.pdf', 'application/pdf'), false);
  assert.equal(needsPngConversion('img.png', 'image/png'), false);
  assert.equal(needsPngConversion('img.jpg', 'image/jpeg'), false);
});

test('toPng converts WebP to PNG', async () => {
  const out = await toPng(await makeImage('webp'), '.webp', 'image/webp');
  assert.ok(isPng(out), 'output starts with PNG magic');
});

test('toPng converts TIFF to PNG', async () => {
  const out = await toPng(await makeImage('tiff'), '.tif', 'image/tiff');
  assert.ok(isPng(out), 'output starts with PNG magic');
});

test('toPng converts HEIC to PNG', async () => {
  const heic = await fs.readFile(path.join(here, 'fixtures', 'sample.heic'));
  const out = await toPng(heic, '.heic', 'image/heic');
  assert.ok(isPng(out), 'output starts with PNG magic');
});

test('toPng rejects an undecodable buffer', async () => {
  await assert.rejects(() => toPng(Buffer.from('not an image'), '.webp', 'image/webp'));
});

test('toPngFilename swaps the extension', () => {
  assert.equal(toPngFilename('photo.heic'), 'photo.png');
  assert.equal(toPngFilename('a.b.webp'), 'a.b.png');
  assert.equal(toPngFilename('noext'), 'noext.png');
});
