const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch;
let admin;
let server;
let baseUrl;
let pool;
let config;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'command-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const addUser = async (username, type = 'member') => (await admin.query(
    `INSERT INTO users (username, email, password_hash, account_type)
     VALUES ($1, $2, 'x', $3) RETURNING id`,
    [username, `${username}@x.test`, type]
  )).rows[0].id;
  ids.ann = await addUser('ann');
  ids.bob = await addUser('bob');
  ids.guest = await addUser('guest', 'guest');
  ids.hrChannel = (await admin.query("SELECT id FROM channels WHERE command_scope = 'hr-inquiry'")).rows[0].id;
  ids.fakeChannel = (await admin.query(
    "INSERT INTO channels (name, topic) VALUES ('another-hr-inquiry', '') RETURNING id"
  )).rows[0].id;
  for (const userId of Object.values({ ann: ids.ann, bob: ids.bob, guest: ids.guest })) {
    await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.hrChannel, userId]);
  }
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.fakeChannel, ids.ann]);
  const vacation = (await admin.query("SELECT id FROM leave_types WHERE name = 'Vacation Leave'")).rows[0].id;
  await admin.query(
    `INSERT INTO leave_requests (user_id, leave_type_id, start_date, end_date, days, status)
     VALUES ($1, $3, '2026-03-02', '2026-03-03', 2, 'approved'),
            ($2, $3, '2026-04-06', '2026-04-10', 5, 'pending')`,
    [ids.ann, ids.bob, vacation]
  );
  const app = express();
  app.use(express.json());
  app.use('/api/commands', require('../src/routes/commands'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
async function call(userId, method, path, body) {
  const response = await fetch(`${baseUrl}/api/commands${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

test('only the immutable HR channel scope exposes commands', async (t) => {
  if (skip(t)) return;
  const available = await call(ids.ann, 'GET', `/?channelId=${ids.hrChannel}`);
  assert.equal(available.status, 200);
  assert.ok(available.json.commands.some((item) => item.name === 'leave-remaining'));
  assert.equal((await call(ids.ann, 'GET', `/?channelId=${ids.fakeChannel}`)).json.commands.length, 0);
  assert.equal((await call(ids.guest, 'GET', `/?channelId=${ids.hrChannel}`)).status, 403);
  await admin.query("UPDATE channels SET name = 'people-help' WHERE id = $1", [ids.hrChannel]);
  assert.ok((await call(ids.ann, 'GET', `/?channelId=${ids.hrChannel}`)).json.commands.length > 0, 'renaming does not remove the immutable scope');
});

test('leave results are requester-only API data and never become messages', async (t) => {
  if (skip(t)) return;
  const ann = await call(ids.ann, 'POST', '/execute', { channelId: ids.hrChannel, command: '/leave-details 2026', requestId: 'ann-1' });
  const bob = await call(ids.bob, 'POST', '/execute', { channelId: ids.hrChannel, command: '/leave-pending 2026', requestId: 'bob-1' });
  assert.equal(ann.status, 200);
  assert.equal(ann.json.visibility, 'private');
  assert.equal(ann.json.requestId, 'ann-1');
  assert.equal(ann.json.data.requests.length, 1);
  assert.equal(ann.json.data.requests[0].days, 2);
  assert.equal(bob.json.data.requests.length, 1);
  assert.equal(bob.json.data.requests[0].days, 5);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n, 0);
  const audits = (await admin.query('SELECT command_name, outcome, request_id FROM command_audit_log ORDER BY id')).rows;
  assert.deepEqual(audits, [
    { command_name: 'leave-details', outcome: 'success', request_id: 'ann-1' },
    { command_name: 'leave-pending', outcome: 'success', request_id: 'bob-1' },
  ]);
});

test('invalid and unavailable commands fail privately without accepting employee identifiers', async (t) => {
  if (skip(t)) return;
  const unavailable = await call(ids.ann, 'POST', '/execute', { channelId: ids.fakeChannel, command: '/leave' });
  assert.equal(unavailable.status, 404);
  assert.match(unavailable.json.error, /not available here/i);
  const injected = await call(ids.ann, 'POST', '/execute', { channelId: ids.hrChannel, command: `/leave-details employee=${ids.bob}` });
  assert.equal(injected.status, 400);
  assert.match(injected.json.error, /leave type/i);
  assert.equal((await call(ids.ann, 'POST', '/execute', { channelId: ids.hrChannel, command: '/unknown' })).status, 404);
});

test('leave cancellation is validated for the requester and returned as a confirmation action', async (t) => {
  if (skip(t)) return;
  const bobRequest = (await admin.query("SELECT id FROM leave_requests WHERE user_id = $1 AND status = 'pending'", [ids.bob])).rows[0].id;
  const candidate = await call(ids.bob, 'POST', '/execute', { channelId: ids.hrChannel, command: `/leave-cancel ${bobRequest}` });
  assert.equal(candidate.status, 200);
  assert.deepEqual(candidate.json.actions, [{ type: 'cancel-leave', requestId: bobRequest }]);
  assert.equal((await admin.query('SELECT status FROM leave_requests WHERE id = $1', [bobRequest])).rows[0].status, 'pending', 'the command only prepares a confirmed action');
  assert.equal((await call(ids.ann, 'POST', '/execute', { channelId: ids.hrChannel, command: `/leave-cancel ${bobRequest}` })).status, 404, 'another employee cannot see it');
});
