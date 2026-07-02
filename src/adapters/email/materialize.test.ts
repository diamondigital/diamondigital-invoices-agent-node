import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import sharp from 'sharp';

import { isZipAttachment, extractZipEntries, materializeAttachments } from './materialize.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ziptest-'));
}

function zipOf(entries: Array<[string, string | Buffer]>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of entries) {
    zip.addFile(name, typeof content === 'string' ? Buffer.from(content) : Buffer.from(content));
  }
  return zip.toBuffer();
}

test('isZipAttachment detects by mime and by extension', () => {
  assert.equal(isZipAttachment({ filename: 'x.pdf', contentType: 'application/zip' }), true);
  assert.equal(isZipAttachment({ filename: 'x.zip', contentType: 'application/octet-stream' }), true);
  assert.equal(isZipAttachment({ filename: 'X.ZIP', contentType: '' }), true);
  assert.equal(isZipAttachment({ filename: 'x.pdf', contentType: 'application/pdf' }), false);
});

test('extractZipEntries writes each file and returns records', async () => {
  const dir = await tmpDir();
  const buf = zipOf([['a.pdf', 'PDF-A'], ['b.jpg', 'JPG-B']]);
  const records = await extractZipEntries(buf, dir);
  assert.equal(records.length, 2);
  const names = records.map((r) => r.filename).sort();
  assert.deepEqual(names, ['a.pdf', 'b.jpg']);
  assert.equal(records[0]?.mimeType, 'application/pdf');
  for (const r of records) {
    assert.equal(path.dirname(r.path), dir);
    assert.equal((await fs.readFile(r.path)).length, r.sizeBytes);
  }
});

test('extractZipEntries guards against zip-slip', async () => {
  const dir = await tmpDir();
  const buf = zipOf([['../evil.pdf', 'X']]);
  const records = await extractZipEntries(buf, dir);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.filename, 'evil.pdf');
  assert.equal(path.dirname(records[0]?.path ?? ''), dir);
});

test('extractZipEntries returns [] for a corrupt buffer without throwing', async () => {
  const dir = await tmpDir();
  const records = await extractZipEntries(Buffer.from('this is not a zip'), dir);
  assert.deepEqual(records, []);
});

test('extractZipEntries disambiguates colliding basenames', async () => {
  const dir = await tmpDir();
  const buf = zipOf([['x.pdf', 'ONE'], ['sub/x.pdf', 'TWO']]);
  const records = await extractZipEntries(buf, dir);
  assert.equal(records.length, 2);
  const names = records.map((r) => r.filename).sort();
  assert.deepEqual(names, ['1_x.pdf', 'x.pdf']);
});

test('extractZipEntries caps entry count at 50', async () => {
  const dir = await tmpDir();
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < 60; i += 1) entries.push([`f${i}.pdf`, `n${i}`]);
  const records = await extractZipEntries(zipOf(entries), dir);
  assert.equal(records.length, 50);
});

function zipWithRawEntryName(rawName: string, content: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('placeholder', Buffer.from(content));
  const entry = zip.getEntries()[0];
  if (entry) entry.entryName = rawName;
  return zip.toBuffer();
}

test('extractZipEntries rejects an entry literally named ".." (zip-slip bypass)', async () => {
  const dir = await tmpDir();
  const parentBefore = await fs.readdir(path.dirname(dir));
  const buf = zipWithRawEntryName('..', 'evil');
  const records = await extractZipEntries(buf, dir);
  assert.deepEqual(records, []);
  const parentAfter = await fs.readdir(path.dirname(dir));
  assert.deepEqual(parentAfter, parentBefore);
});

test('extractZipEntries rejects an entry named "foo/.." (zip-slip bypass)', async () => {
  const dir = await tmpDir();
  const buf = zipWithRawEntryName('foo/..', 'evil');
  const records = await extractZipEntries(buf, dir);
  assert.deepEqual(records, []);
});

test('extractZipEntries skips an entry when writeFile fails, without throwing', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'bad.pdf'));
  const buf = zipOf([['bad.pdf', 'X'], ['good.pdf', 'Y']]);
  const records = await extractZipEntries(buf, dir);
  assert.deepEqual(records.map((r) => r.filename), ['good.pdf']);
});

test('extractZipEntries checks the byte cap before decompressing (uses header size)', async () => {
  const dir = await tmpDir();
  const zip = new AdmZip();
  zip.addFile('huge.pdf', Buffer.from('small-compressed-content'));
  const buf = zip.toBuffer();
  const rebuilt = new AdmZip(buf);
  const entry = rebuilt.getEntries()[0];
  if (entry) entry.header.size = 200 * 1024 * 1024;
  const records = await extractZipEntries(rebuilt.toBuffer(), dir);
  assert.deepEqual(records, []);
});

test('materializeAttachments expands zips and passes through normal files', async () => {
  const dir = await tmpDir();
  const zipBuf = zipOf([['inv1.pdf', 'A'], ['inv2.pdf', 'B']]);
  const parsed = [
    { filename: 'pack.zip', content: zipBuf, contentType: 'application/zip', size: zipBuf.length },
    { filename: 'direct.pdf', content: Buffer.from('DIRECT'), contentType: 'application/pdf', size: 6 },
  ];
  const records = await materializeAttachments(parsed, dir);
  const names = records.map((r) => r.filename).sort();
  assert.deepEqual(names, ['direct.pdf', 'inv1.pdf', 'inv2.pdf']);
  assert.equal(records.find((r) => r.filename === 'pack.zip'), undefined);
});

test('materializeAttachments skips a corrupt zip but keeps other attachments', async () => {
  const dir = await tmpDir();
  const parsed = [
    { filename: 'bad.zip', content: Buffer.from('nope'), contentType: 'application/zip', size: 4 },
    { filename: 'good.pdf', content: Buffer.from('OK'), contentType: 'application/pdf', size: 2 },
  ];
  const records = await materializeAttachments(parsed, dir);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.filename, 'good.pdf');
});

test('materializeAttachments skips attachments with no filename', async () => {
  const dir = await tmpDir();
  const parsed = [{ content: Buffer.from('X'), contentType: 'application/pdf', size: 1 }];
  const records = await materializeAttachments(parsed, dir);
  assert.deepEqual(records, []);
});

test('materializeAttachments de-collides a zip entry against a same-named direct attachment', async () => {
  const dir = await tmpDir();
  const zipBuf = zipOf([['dup.pdf', 'FROM-ZIP']]);
  const parsed = [
    { filename: 'pack.zip', content: zipBuf, contentType: 'application/zip', size: zipBuf.length },
    { filename: 'dup.pdf', content: Buffer.from('DIRECT'), contentType: 'application/pdf', size: 6 },
  ];
  const records = await materializeAttachments(parsed, dir);
  assert.equal(records.length, 2);
  const names = records.map((r) => r.filename);
  assert.equal(new Set(names).size, 2, 'filenames must be distinct');
  assert.ok(names.includes('dup.pdf'));
  const paths = new Set(records.map((r) => r.path));
  assert.equal(paths.size, 2);
  for (const r of records) await fs.access(r.path);
});

const JAVA_ENVELOPE = Buffer.from([
  0xac, 0xed, 0x00, 0x05, 0x75, 0x72, 0x00, 0x02, 0x5b, 0x42,
]);

test('extractZipEntries strips a java-serialization envelope before %PDF', async () => {
  const dir = await tmpDir();
  const pdf = Buffer.from('%PDF-1.5\nreal content\n%%EOF');
  const wrapped = Buffer.concat([JAVA_ENVELOPE, pdf]);
  const records = await extractZipEntries(zipOf([['doklad.pdf', wrapped]]), dir);
  assert.equal(records.length, 1);
  const written = await fs.readFile(records[0]?.path ?? '');
  assert.ok(written.subarray(0, 4).equals(Buffer.from('%PDF')), 'written file starts with %PDF');
  assert.equal(records[0]?.sizeBytes, pdf.length);
});

test('extractZipEntries leaves a clean %PDF file untouched', async () => {
  const dir = await tmpDir();
  const pdf = Buffer.from('%PDF-1.4\nclean\n%%EOF');
  const records = await extractZipEntries(zipOf([['clean.pdf', pdf]]), dir);
  const written = await fs.readFile(records[0]?.path ?? '');
  assert.ok(written.equals(pdf));
});

test('extractZipEntries does not strip non-document types even if they contain %PDF', async () => {
  const dir = await tmpDir();
  const png = Buffer.concat([Buffer.from([0xac, 0xed]), Buffer.from('junk %PDF junk')]);
  const records = await extractZipEntries(zipOf([['image.png', png]]), dir);
  const written = await fs.readFile(records[0]?.path ?? '');
  assert.ok(written.equals(png), 'png left untouched');
});

test('materializeAttachments strips a java envelope from a direct pdf attachment', async () => {
  const dir = await tmpDir();
  const pdf = Buffer.from('%PDF-1.5\nx\n%%EOF');
  const wrapped = Buffer.concat([JAVA_ENVELOPE, pdf]);
  const parsed = [{ filename: 'doklad.pdf', content: wrapped, contentType: 'application/pdf', size: wrapped.length }];
  const records = await materializeAttachments(parsed, dir);
  const written = await fs.readFile(records[0]?.path ?? '');
  assert.ok(written.subarray(0, 4).equals(Buffer.from('%PDF')));
  assert.equal(records[0]?.sizeBytes, pdf.length);
});

async function webpBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .webp().toBuffer();
}

test('materializeAttachments converts a WebP attachment to PNG', async () => {
  const dir = await tmpDir();
  const records = await materializeAttachments(
    [{ filename: 'receipt.webp', content: await webpBuffer(), contentType: 'image/webp' }],
    dir,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]?.filename, 'receipt.png');
  assert.equal(records[0]?.mimeType, 'image/png');
  const onDisk = await fs.readFile(records[0]?.path ?? '');
  assert.equal(onDisk[0], 0x89);
  assert.equal(onDisk.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(onDisk.length, records[0]?.sizeBytes);
});

test('materializeAttachments skips an unconvertible image but keeps others', async () => {
  const dir = await tmpDir();
  const records = await materializeAttachments(
    [
      { filename: 'broken.webp', content: Buffer.from('not an image'), contentType: 'image/webp' },
      { filename: 'good.pdf', content: Buffer.from('%PDF-1.4 body'), contentType: 'application/pdf' },
    ],
    dir,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]?.filename, 'good.pdf');
});
