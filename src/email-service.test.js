import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';

import { isZipAttachment, extractZipEntries, materializeAttachments } from './email-service.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ziptest-'));
}

function zipOf(entries) {
  const zip = new AdmZip();
  for (const [name, content] of entries) zip.addFile(name, Buffer.from(content));
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
  assert.equal(records[0].mimeType, 'application/pdf');
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
  assert.equal(records[0].filename, 'evil.pdf');
  assert.equal(path.dirname(records[0].path), dir);
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
  const entries = [];
  for (let i = 0; i < 60; i += 1) entries.push([`f${i}.pdf`, `n${i}`]);
  const records = await extractZipEntries(zipOf(entries), dir);
  assert.equal(records.length, 50);
});

// adm-zip's addFile() sanitizes ".." itself, so a hostile entry name must be
// forced onto the entry object directly to reproduce what a crafted/hostile
// zip byte stream can contain.
function zipWithRawEntryName(rawName, content) {
  const zip = new AdmZip();
  zip.addFile('placeholder', Buffer.from(content));
  zip.getEntries()[0].entryName = rawName;
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
  // Make the destination path for "bad.pdf" a directory, so writeFile(filePath, data)
  // fails with EISDIR instead of succeeding.
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
  // Lie about the uncompressed size in the header to simulate a single entry
  // that would blow the cap once decompressed — the guard must reject it
  // using header.size before calling getData(), so getData() (which would
  // detect the size lie via CRC/size mismatch) must never even run.
  rebuilt.getEntries()[0].header.size = 200 * 1024 * 1024;
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
  assert.equal(records[0].filename, 'good.pdf');
});

test('materializeAttachments skips attachments with no filename', async () => {
  const dir = await tmpDir();
  const parsed = [{ content: Buffer.from('X'), contentType: 'application/pdf', size: 1 }];
  const records = await materializeAttachments(parsed, dir);
  assert.deepEqual(records, []);
});
