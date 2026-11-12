// The pre-launch shared test password, against a real PostgreSQL (scratch database).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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
  process.env.JWT_SECRET = 'prelaunch-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const hash = bcrypt.hashSync('Own-password-1', 4);
  const user = async (name, { type = 'member', superadmin = false, hr = false } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin, is_hr) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [name, `${name}@x.test`, hash, type, superadmin, hr]
  )).rows[0].id;
  ids.boss = await user('boss', { superadmin: true });
  ids.hr = await user('hana', { hr: true });
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  ids.guest = await user('visitor', { type: 'guest' });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/admin', require('../src/routes/admin'));
  app.use('/api/hr', require('../src/routes/hr'));
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

const call = async (userId, method, path, body) => {
  // sign with the account's current token version, as a signed-in browser would after a fresh login
  const tokenVersion = userId ? (await admin.query('SELECT token_version FROM users WHERE id = $1', [userId])).rows[0].token_version : 0;
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { ...(userId ? { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion }, config.JWT_SECRET)}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const login = (username, password) => call(0, 'POST', '/auth/login', { username, password });
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

test('only the Superadmin controls it, and it starts off', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.hr, 'GET', '/admin/prelaunch')).status, 403, 'not even HR');
  assert.equal((await call(ids.ann, 'PUT', '/admin/prelaunch', { enabled: true })).status, 403);
  const state = await call(ids.boss, 'GET', '/admin/prelaunch');
  assert.deepEqual(state.json, { enabled: false, password: 'testpass123' });
  assert.equal((await call(ids.boss, 'PUT', '/admin/prelaunch', { enabled: 'yes' })).status, 400);
  assert.equal((await call(ids.boss, 'POST', '/admin/prelaunch/apply')).status, 409, 'switch it on first');
});

test('off: new accounts get a random temporary password and must change it', async (t) => {
  if (skip(t)) return;
  const made = await call(ids.hr, 'POST', '/admin/users', { accounts: [{ username: 'before', email: 'before@x.test' }] });
  assert.notEqual(made.json.created[0].password, 'testpass123');
  assert.equal((await login('before', made.json.created[0].password)).json.user.mustChangePassword, true);
});

test('on: apply gives every employee the shared password, except Superadmins, guests and the deactivated', async (t) => {
  if (skip(t)) return;
  await admin.query("INSERT INTO users (username, email, password_hash, deactivated_at) VALUES ('gone', 'gone@x.test', 'x', NOW())");
  assert.equal((await call(ids.boss, 'PUT', '/admin/prelaunch', { enabled: true })).json.enabled, true);
  const applied = await call(ids.boss, 'POST', '/admin/prelaunch/apply');
  assert.equal(applied.status, 200);
  assert.ok(applied.json.changed >= 4, 'ann, bob, hana and the account made earlier');

  for (const name of ['ann', 'bob', 'hana', 'before']) {
    const res = await login(name, 'testpass123');
    assert.equal(res.status, 200, `${name} signs in with the shared password`);
    assert.equal(res.json.user.mustChangePassword, false, 'and is not forced to change it');
  }
  assert.equal((await login('boss', 'testpass123')).status, 401, 'the Superadmin keeps their own password');
  assert.equal((await login('boss', 'Own-password-1')).status, 200);
  assert.equal((await login('visitor', 'testpass123')).status, 401, 'guests are not touched');
  assert.equal((await login('visitor', 'Own-password-1')).status, 200);
  assert.equal((await admin.query("SELECT password_hash FROM users WHERE username = 'gone'")).rows[0].password_hash, 'x', 'nor the deactivated');
});

test('on: new accounts and password resets use the shared password without forcing a change', async (t) => {
  if (skip(t)) return;
  const made = await call(ids.hr, 'POST', '/admin/users', { accounts: [{ username: 'during', email: 'during@x.test' }, { username: 'chosen', email: 'chosen@x.test', password: 'Mine-own-pass-1' }] });
  assert.equal(made.json.created[0].password, 'testpass123');
  assert.equal((await login('during', 'testpass123')).json.user.mustChangePassword, false);
  assert.equal((await login('chosen', 'Mine-own-pass-1')).json.user.mustChangePassword, true, 'a password HR typed is still a temporary one');
  const guest = await call(ids.boss, 'POST', '/admin/users', { accounts: [{ username: 'g2', email: 'g2@x.test' }], accountType: 'guest', channelIds: [1] });
  assert.notEqual(guest.json.created[0].password, 'testpass123', 'guests never get it');

  await admin.query("UPDATE users SET password_hash = $1 WHERE username = 'bob'", [bcrypt.hashSync('Forgot-1-pass', 4)]);
  const reset = await call(ids.hr, 'POST', `/hr/employees/${ids.bob}/reset-password`, {});
  assert.equal(reset.json.password, 'testpass123');
  assert.equal((await login('bob', 'testpass123')).json.user.mustChangePassword, false);
});

test('apply signs people out, and going live makes everyone choose a new password', async (t) => {
  if (skip(t)) return;
  const before = (await admin.query("SELECT token_version FROM users WHERE username = 'ann'")).rows[0].token_version;
  await call(ids.boss, 'POST', '/admin/prelaunch/apply');
  assert.equal((await admin.query("SELECT token_version FROM users WHERE username = 'ann'")).rows[0].token_version, before + 1);

  const live = await call(ids.boss, 'POST', '/admin/prelaunch/go-live');
  assert.equal(live.status, 200);
  assert.equal(live.json.enabled, false);
  assert.ok(live.json.mustChange >= 4);
  assert.equal((await call(ids.boss, 'GET', '/admin/prelaunch')).json.enabled, false);
  assert.equal((await login('ann', 'testpass123')).json.user.mustChangePassword, true, 'still signs in, but must pick a new password now');
  assert.equal((await login('boss', 'Own-password-1')).json.user.mustChangePassword, false, 'the Superadmin is not forced');
  const after = await call(ids.hr, 'POST', '/admin/users', { accounts: [{ username: 'after', email: 'after@x.test' }] });
  assert.notEqual(after.json.created[0].password, 'testpass123', 'back to random temporary passwords');

  const log = (await admin.query("SELECT action FROM moderation_audit_log WHERE action LIKE 'prelaunch%' ORDER BY id")).rows.map((r) => r.action);
  assert.deepEqual(log, ['prelaunch_password_on', 'prelaunch_password_applied', 'prelaunch_password_applied', 'prelaunch_went_live']);
});
