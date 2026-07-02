import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, assertConfig } from './config.js';

function validConfig() {
  return {
    email: { host: 'h', port: 993, user: 'u', password: 'p' },
    trivi: { appId: 'id', appSecret: 'sec' },
  };
}

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

test('assertConfig passes for a valid config and returns it', () => {
  const cfg = validConfig();
  assert.equal(assertConfig(cfg), cfg);
});

test('assertConfig does not require optional fields (mistral/notification/s3)', () => {
  const cfg = validConfig();
  assert.doesNotThrow(() => assertConfig(cfg));
});

test('assertConfig throws listing all missing/invalid fields at once', () => {
  const cfg = {
    email: { host: '', port: 0, user: 'u', password: '' },
    trivi: { appId: 'id', appSecret: '' },
  };
  assert.throws(
    () => assertConfig(cfg),
    (err) => {
      assert.match(err.message, /^Invalid config: /);
      assert.match(err.message, /email\.host/);
      assert.match(err.message, /email\.port/);
      assert.match(err.message, /email\.password/);
      assert.match(err.message, /trivi\.appSecret/);
      assert.doesNotMatch(err.message, /email\.user/);
      assert.doesNotMatch(err.message, /trivi\.appId/);
      return true;
    }
  );
});

test('assertConfig flags a non-finite / non-positive port', () => {
  const cfg = validConfig();
  cfg.email.port = NaN;
  assert.throws(() => assertConfig(cfg), /email\.port/);
  const cfg2 = validConfig();
  cfg2.email.port = -1;
  assert.throws(() => assertConfig(cfg2), /email\.port/);
});

test('assertConfig tolerates missing nested objects', () => {
  assert.throws(
    () => assertConfig({}),
    (err) => {
      assert.match(err.message, /email\.host/);
      assert.match(err.message, /trivi\.appId/);
      return true;
    }
  );
});

test('loadConfig throws when trivi.appSecret is empty from env', async () => {
  const prev = { ...process.env };
  delete process.env.SECRET_NAME;
  Object.assign(process.env, {
    EMAIL_HOST: 'h', EMAIL_PORT: '993', EMAIL_USER: 'u', EMAIL_PASSWORD: 'p',
    TRIVI_APP_ID: 'id',
  });
  delete process.env.TRIVI_APP_SECRET;
  await assert.rejects(() => loadConfig(), /Missing required env var: TRIVI_APP_SECRET/);
  process.env = prev;
});
