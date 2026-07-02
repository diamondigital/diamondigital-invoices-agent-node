import test from 'node:test';
import assert from 'node:assert/strict';

import { S3StorageAdapter } from './s3-storage.js';

test('archiveEmail skips without throwing when bucket is unconfigured', async () => {
  const adapter = new S3StorageAdapter({ bucketName: '' });
  await assert.doesNotReject(adapter.archiveEmail('email-1', '{}'));
});
