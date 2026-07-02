import test from 'node:test';
import assert from 'node:assert/strict';
import { EmailService } from './client.js';

function makeFakeClient(existingFolders = []) {
  const calls = {
    connect: 0,
    logout: 0,
    list: 0,
    mailboxCreate: [],
    messageMove: [],
    locks: [],
  };
  const folders = new Set(existingFolders);
  const client = {
    calls,
    mailbox: { exists: 0 },
    async connect() {
      calls.connect += 1;
    },
    async logout() {
      calls.logout += 1;
    },
    async list() {
      calls.list += 1;
      return [...folders].map((path) => ({ path }));
    },
    async mailboxCreate(name) {
      calls.mailboxCreate.push(name);
      folders.add(name);
    },
    async getMailboxLock(mailbox) {
      calls.locks.push(mailbox);
      return { release() {} };
    },
    async *fetch() {
    },
    async messageMove(range, dest) {
      calls.messageMove.push({ range, dest });
    },
  };
  return client;
}

function makeService(client, overrides = {}) {
  return new EmailService({
    host: 'imap.example.com',
    port: 993,
    secure: true,
    user: 'u',
    password: 'p',
    processedLabel: 'TRIVI',
    skippedFolder: 'Bez dokladu',
    clientFactory: () => client,
    ...overrides,
  });
}

test('connect() opens the client once and creates only the missing folders', async () => {
  const client = makeFakeClient(['INBOX', 'TRIVI']);
  const svc = makeService(client);

  await svc.connect();

  assert.equal(client.calls.connect, 1);
  assert.equal(client.calls.list, 1, 'folders checked exactly once');
  assert.deepEqual(client.calls.mailboxCreate, ['Bez dokladu'], 'only the missing folder is created');
});

test('connect() creates both folders when neither exists', async () => {
  const client = makeFakeClient(['INBOX']);
  const svc = makeService(client);

  await svc.connect();

  assert.deepEqual(
    [...client.calls.mailboxCreate].sort(),
    ['Bez dokladu', 'TRIVI'].sort()
  );
});

test('connect() is idempotent — a second call does not re-open or re-check', async () => {
  const client = makeFakeClient(['INBOX', 'TRIVI', 'Bez dokladu']);
  const svc = makeService(client);

  await svc.connect();
  await svc.connect();

  assert.equal(client.calls.connect, 1);
  assert.equal(client.calls.list, 1);
});

test('markAsProcessed then markAsSkipped reuse one connection and never re-check folders', async () => {
  const client = makeFakeClient(['INBOX', 'TRIVI', 'Bez dokladu']);
  const svc = makeService(client);

  await svc.connect();
  const listAfterConnect = client.calls.list;

  await svc.markAsProcessed('11');
  await svc.markAsSkipped('22');

  assert.equal(client.calls.connect, 1, 'no new connections per move');
  assert.equal(client.calls.list, listAfterConnect, 'no per-move folder-existence check');
});

test('markAsProcessed moves to the processed folder, markAsSkipped to the skipped folder', async () => {
  const client = makeFakeClient(['INBOX', 'TRIVI', 'Bez dokladu']);
  const svc = makeService(client);

  await svc.connect();
  await svc.markAsProcessed('11');
  await svc.markAsSkipped('22');

  assert.deepEqual(client.calls.messageMove, [
    { range: { uid: '11' }, dest: 'TRIVI' },
    { range: { uid: '22' }, dest: 'Bez dokladu' },
  ]);
  assert.ok(client.calls.locks.includes('INBOX'));
});

test('disconnect() logs out and is safe to call twice', async () => {
  const client = makeFakeClient(['INBOX', 'TRIVI', 'Bez dokladu']);
  const svc = makeService(client);

  await svc.connect();
  await svc.disconnect();
  await svc.disconnect();

  assert.equal(client.calls.logout, 1);
});

test('disconnect() is safe when never connected', async () => {
  const client = makeFakeClient();
  const svc = makeService(client);
  await svc.disconnect();
  assert.equal(client.calls.logout, 0);
});

test('fetchUnprocessedEmails() returns [] on empty INBOX without opening its own connection', async () => {
  const client = makeFakeClient(['INBOX', 'TRIVI', 'Bez dokladu']);
  client.mailbox = { exists: 0 };
  const svc = makeService(client);

  await svc.connect();
  const emails = await svc.fetchUnprocessedEmails();

  assert.deepEqual(emails, []);
  assert.equal(client.calls.connect, 1, 'fetch reuses the persistent connection');
});

test('fetchUnprocessedEmails() parses messages into the expected shape', async () => {
  const client = makeFakeClient(['INBOX', 'TRIVI', 'Bez dokladu']);
  client.mailbox = { exists: 1 };
  const source = Buffer.from(
    [
      'From: Alice <alice@example.com>',
      'Subject: Faktura 2026',
      'Date: Wed, 01 Jul 2026 10:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Body text here',
      '',
    ].join('\r\n')
  );
  client.fetch = async function* () {
    yield { uid: 99, source };
  };
  const svc = makeService(client);

  await svc.connect();
  const emails = await svc.fetchUnprocessedEmails();

  assert.equal(emails.length, 1);
  const [msg] = emails;
  assert.equal(msg.emailId, '99');
  assert.equal(typeof msg.emailId, 'string');
  assert.equal(msg.subject, 'Faktura 2026');
  assert.match(msg.from, /alice@example.com/);
  assert.ok(msg.receivedDate instanceof Date);
  assert.match(msg.bodyText, /Body text here/);
  assert.deepEqual(msg.attachments, []);
});
