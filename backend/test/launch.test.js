// The go-live switch (Pre-launch / Live), against a real PostgreSQL (scratch database).
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
  process.env.JWT_SECRET = 'launch-test-secret-that-is-long-enough-123';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, superadmin = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', superadmin]
  )).rows[0].id;
  ids.boss = await user('boss', true);
  ids.ann = await user('ann');
  const app = express();
  app.use(express.json());
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

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const call = async (userId, method, path, headers = {}) => {
  const res = await fetch(`${baseUrl}/api/admin${path}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : '{}',
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const check = (state, id) => state.checks.find((c) => c.id === id);

test('only the Superadmin may read or change the launch mode', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'GET', '/launch')).status, 403);
  assert.equal((await call(ids.ann, 'POST', '/launch/go-live')).status, 403);
});

test('before launch: not live, the shared password is flagged, and no office network is a blocker', async (t) => {
  if (skip(t)) return;
  await admin.query('UPDATE moderation_settings SET prelaunch_password = TRUE WHERE id = 1');
  const state = (await call(ids.boss, 'GET', '/launch')).json;
  assert.equal(state.live, false);
  assert.equal(check(state, 'shared_password').ok, false);
  assert.equal(check(state, 'office_network').ok, false);
  assert.deepEqual(state.blockers, ['office_network']);
  assert.equal(check(state, 'https').ok, false, 'plain http is a warning');
  assert.equal(check(state, 'https').blocker, false);
  const secure = (await call(ids.boss, 'GET', '/launch', { 'X-Forwarded-Proto': 'https' })).json;
  assert.equal(check(secure, 'https').ok, true);
  const proxied = (await call(ids.boss, 'GET', '/launch', { 'X-Forwarded-For': '10.0.0.5' })).json;
  assert.equal(check(proxied, 'proxy_ip').ok, false, 'a proxy without TRUST_PROXY is flagged');
});

test('going live is refused while a blocker remains, and changes nothing', async (t) => {
  if (skip(t)) return;
  const refused = await call(ids.boss, 'POST', '/launch/go-live');
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /office network/i);
  assert.equal((await admin.query('SELECT prelaunch_password, go_live FROM moderation_settings WHERE id = 1')).rows[0].go_live, false);
  assert.equal((await admin.query('SELECT network_only FROM attendance_settings WHERE id = 1')).rows[0].network_only, false);
});

test('going live turns the rules on together; returning to pre-launch relaxes clocking but never brings the shared password back', async (t) => {
  if (skip(t)) return;
  await admin.query("INSERT INTO attendance_networks (label, cidr) VALUES ('Office', '192.168.18.0/24')");
  const live = await call(ids.boss, 'POST', '/launch/go-live');
  assert.equal(live.status, 200);
  assert.equal(live.json.live, true);
  assert.equal(check(live.json, 'office_network').ok, true);
  assert.ok(live.json.mustChange >= 1);
  const row = (await admin.query('SELECT prelaunch_password FROM moderation_settings WHERE id = 1')).rows[0];
  assert.equal(row.prelaunch_password, false, 'the shared password is off');
  assert.equal((await admin.query('SELECT network_only FROM attendance_settings WHERE id = 1')).rows[0].network_only, true);
  assert.equal((await admin.query('SELECT must_change_password FROM users WHERE id = $1', [ids.ann])).rows[0].must_change_password, true);
  assert.equal((await admin.query('SELECT must_change_password FROM users WHERE id = $1', [ids.boss])).rows[0].must_change_password, false, 'the Superadmin keeps their password');

  const back = await call(ids.boss, 'POST', '/launch/pre-launch');
  assert.equal(back.status, 200);
  assert.equal(back.json.live, false);
  assert.equal((await admin.query('SELECT network_only FROM attendance_settings WHERE id = 1')).rows[0].network_only, false);
  assert.equal((await admin.query('SELECT prelaunch_password FROM moderation_settings WHERE id = 1')).rows[0].prelaunch_password, false, 'still off');
  const audit = await admin.query("SELECT action FROM moderation_audit_log WHERE action IN ('went_live', 'back_to_prelaunch') ORDER BY id");
  assert.deepEqual(audit.rows.map((r) => r.action), ['went_live', 'back_to_prelaunch']);
});
