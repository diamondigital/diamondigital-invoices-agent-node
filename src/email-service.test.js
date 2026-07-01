import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';

import { isZipAttachment, extractZipEntries } from './email-service.js';

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
