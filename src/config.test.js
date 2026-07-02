import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

test('loadConfig reads from env when SECRET_NAME is empty', async () => {
  const prev = { ...process.env };
  delete process.env.SECRET_NAME;
  Object.assign(process.env, { EMAIL_HOST: 'h', EMAIL_PORT: '993', EMAIL_USER: 'u', EMAIL_PASSWORD: 'p', TRIVI_APP_ID: 'id', TRIVI_APP_SECRET: 'sec' });
  const cfg = await loadConfig();
  assert.equal(cfg.email.host, 'h');
  assert.equal(cfg.email.port, 993);
  assert.equal(cfg.trivi.appId, 'id');
  process.env = prev;
});

test('loadConfig throws when a required env var is missing', async () => {
  const prev = { ...process.env };
  delete process.env.SECRET_NAME;
  delete process.env.EMAIL_HOST;
  await assert.rejects(() => loadConfig(), /Missing required env var: EMAIL_HOST/);
  process.env = prev;
});
