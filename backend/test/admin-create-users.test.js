// The Superadmin creates accounts directly (one or many), and each person replaces the temporary password.
// Real PostgreSQL (scratch database); skipped when none is reachable.
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
  process.env.JWT_SECRET = 'admin-create-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, superadmin) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', superadmin]
  )).rows[0].id;
  ids.boss = await user('boss', true);
  ids.ann = await user('ann', false);
  // the base schema seeds the public channels every member joins
  ids.pubs = (await admin.query('SELECT id FROM channels WHERE is_private = false ORDER BY id')).rows.map((r) => r.id);
  assert.ok(ids.pubs.length > 0);
  ids.priv = (await admin.query("INSERT INTO channels (name, is_private, created_by) VALUES ('secret', true, $1) RETURNING id", [ids.boss])).rows[0].id;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/admin', require('../src/routes/admin'));
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

const bearer = (userId, tokenVersion = 0) => jwt.sign({ userId, username: 'u', tokenVersion }, config.JWT_SECRET);
const call = async (method, path, body, token) => {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

test('only the Superadmin creates accounts; passwords are generated when missing', async (t) => {
  if (skip(t)) return;
  const body = { accounts: [{ username: 'newbie', email: 'newbie@x.test' }] };
  assert.equal((await call('POST', '/admin/users', body, bearer(ids.ann))).status, 403);
  const made = await call('POST', '/admin/users', body, bearer(ids.boss));
  assert.equal(made.status, 201);
  const [account] = made.json.created;
  assert.equal(account.username, 'newbie');
  assert.match(account.password, /^[A-Za-z2-9]{12}$/);

  const login = await call('POST', '/auth/login', { username: 'newbie', password: account.password });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.mustChangePassword, true);
  const row = (await admin.query("SELECT account_type, password_hash FROM users WHERE username = 'newbie'")).rows[0];
  assert.equal(row.account_type, 'member');
  assert.notEqual(row.password_hash, account.password, 'only a hash is stored');
  const joined = (await admin.query('SELECT channel_id FROM channel_members WHERE user_id = $1', [account.id])).rows.map((r) => r.channel_id);
  assert.deepEqual(joined.sort((x, y) => x - y), ids.pubs, 'a member joins the public channels, not private ones');
});

test('many at once: duplicates and bad rows are skipped with a reason, the rest are created', async (t) => {
  if (skip(t)) return;
  const made = await call('POST', '/admin/users', {
    accounts: [
      { username: 'cara', email: 'cara@x.test', password: 'Chosen-pass-1' },
      { username: 'dan', email: 'dan@x.test' },
      { username: 'ann', email: 'other@x.test' },
      { username: 'eve', email: 'ann@x.test' },
      { username: 'bad name', email: 'x@x.test' },
      { username: 'fay', email: 'not-an-email' },
      { username: 'gus', email: 'gus@x.test', password: 'short' },
      { username: 'dan', email: 'dan2@x.test' },
    ],
  }, bearer(ids.boss));
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.created.map((c) => c.username), ['cara', 'dan']);
  assert.equal(made.json.created[0].password, 'Chosen-pass-1', 'a given password is kept');
  const reasons = Object.fromEntries(made.json.skipped.map((s) => [s.username, s.reason]));
  assert.match(reasons.ann, /already exists/);
  assert.match(reasons.eve, /already exists/);
  assert.match(reasons['bad name'], /username/);
  assert.match(reasons.fay, /email/);
  assert.match(reasons.gus, /at least 8/);
  assert.equal(made.json.skipped.filter((s) => s.username === 'dan').length, 1, 'listed twice');
});

test('guests need channels, and a member can be put in a private channel too', async (t) => {
  if (skip(t)) return;
  const accounts = [{ username: 'visitor1', email: 'v1@x.test' }];
  assert.equal((await call('POST', '/admin/users', { accounts, accountType: 'guest' }, bearer(ids.boss))).status, 400);
  const guest = await call('POST', '/admin/users', { accounts, accountType: 'guest', channelIds: [ids.priv] }, bearer(ids.boss));
  assert.equal(guest.status, 201);
  const guestRow = (await admin.query("SELECT id, account_type FROM users WHERE username = 'visitor1'")).rows[0];
  assert.equal(guestRow.account_type, 'guest');
  assert.deepEqual((await admin.query('SELECT channel_id FROM channel_members WHERE user_id = $1', [guestRow.id])).rows.map((r) => r.channel_id), [ids.priv]);

  const member = await call('POST', '/admin/users', { accounts: [{ username: 'hal', email: 'hal@x.test' }], channelIds: [ids.priv] }, bearer(ids.boss));
  const halId = member.json.created[0].id;
  const halChannels = (await admin.query('SELECT channel_id FROM channel_members WHERE user_id = $1 ORDER BY channel_id', [halId])).rows.map((r) => r.channel_id);
  assert.deepEqual(halChannels, [...ids.pubs, ids.priv].sort((x, y) => x - y));

  assert.equal((await call('POST', '/admin/users', { accounts: [] }, bearer(ids.boss))).status, 400);
  assert.equal((await call('POST', '/admin/users', { accounts: new Array(101).fill({ username: 'a', email: 'a@x.test' }) }, bearer(ids.boss))).status, 400);
});

test('a person replaces the temporary password in their account settings; other sessions end and the prompt goes away', async (t) => {
  if (skip(t)) return;
  const made = await call('POST', '/admin/users', { accounts: [{ username: 'ivy', email: 'ivy@x.test' }] }, bearer(ids.boss));
  const { password } = made.json.created[0];
  const first = (await call('POST', '/auth/login', { username: 'ivy', password })).json.token;
  const change = (currentPassword, newPassword) => call('PUT', '/auth/me/account', { currentPassword, newPassword }, first);
  assert.equal((await change('wrong-wrong', 'A-new-password-1')).status, 401);
  assert.equal((await change(password, 'short')).status, 400);
  const changed = await change(password, 'A-new-password-1');
  assert.equal(changed.status, 200);
  assert.ok([401, 403].includes((await call('GET', '/auth/me', undefined, first)).status), 'the old session is signed out');
  const me = await call('GET', '/auth/me', undefined, changed.json.token);
  assert.equal(me.status, 200);
  assert.equal(me.json.user.mustChangePassword, false);
  assert.equal((await call('POST', '/auth/login', { username: 'ivy', password })).status, 401);
  assert.equal((await call('POST', '/auth/login', { username: 'ivy', password: 'A-new-password-1' })).json.user.mustChangePassword, false);
});

test('accounts can be created with last, first and middle names', async (t) => {
  if (skip(t)) return;
  const made = await call('POST', '/admin/users', { accounts: [
    { username: 'named1', email: 'named1@x.test', lastName: 'Lee', firstName: 'Ann', middleName: 'Marie' },
    { username: 'named2', email: 'named2@x.test', lastName: 'x'.repeat(101) },
  ] }, bearer(ids.boss));
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.created.map((c) => c.username), ['named1']);
  assert.match(made.json.skipped[0].reason, /Last name/);
  const row = (await admin.query("SELECT last_name, first_name, middle_name FROM users WHERE username = 'named1'")).rows[0];
  assert.deepEqual(row, { last_name: 'Lee', first_name: 'Ann', middle_name: 'Marie' });
});
