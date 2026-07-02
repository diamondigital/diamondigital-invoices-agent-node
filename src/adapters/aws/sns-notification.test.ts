import test from 'node:test';
import assert from 'node:assert/strict';

import { SnsNotificationAdapter } from './sns-notification.js';

test('sendSummary and sendAlert skip without throwing when topic is unconfigured', async () => {
  const adapter = new SnsNotificationAdapter({ snsTopicArn: '', adminEmail: 'admin@example.com' });
  await assert.doesNotReject(adapter.sendSummary('summary'));
  await assert.doesNotReject(adapter.sendAlert('subject', 'body'));
});
