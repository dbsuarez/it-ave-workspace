// "View as": the pure rules, and the real flow against PostgreSQL (an Owner gets a read-only token for another person).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { viewAsRefusal } = require('../src/viewAs');
const { createScratchDatabase } = require('./helpers/scratchDb');

test('in testing mode every GET is allowed except signing in elsewhere and starting another View as; writes never are', () => {
  for (const path of ['/api/conversations', '/api/notes', '/api/saved', '/api/search?q=a', '/api/files', '/api/leave/summary']) {
    assert.equal(viewAsRefusal('GET', path, { full: true }), null, path);
    assert.match(viewAsRefusal('GET', path, { full: false }), /private/, path);
  }
  assert.match(viewAsRefusal('GET', '/api/auth/login', { full: true }), /not available/);
  assert.equal(viewAsRefusal('GET', '/api/auth/me', { full: true }), null);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.match(viewAsRefusal(method, '/api/notes', { full: true }), /read-only/);
});

test('View as may read channels, channel messages, people and lists, and nothing that writes or is private', () => {
  for (const path of ['/api/auth/me', '/api/channels', '/api/channels/my', '/api/channels/4/members', '/api/messages/4', '/api/messages/4?limit=50',
    '/api/messages/4/pins', '/api/messages/4/threads/9', '/api/people', '/api/people/3', '/api/users', '/api/user-groups',
    '/api/roles/mentionable', '/api/moderation/access', '/api/canvas/channel/4', '/api/lists', '/api/lists/2', '/api/settings', '/api/settings/sidebar']) {
    assert.equal(viewAsRefusal('GET', path), null, path);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.match(viewAsRefusal(method, '/api/people'), /read-only/);
  for (const path of ['/api/conversations', '/api/conversations/3', '/api/notes', '/api/saved', '/api/reminders', '/api/scheduled', '/api/search?q=a',
    '/api/files', '/api/canvas/dm/3', '/api/canvases', '/api/leave/summary', '/api/attendance/today', '/api/hr/employees', '/api/admin/users',
    '/api/activity', '/api/users/heartbeat']) {
    assert.match(viewAsRefusal('GET', path), /private/, path);
  }
});

let scratch;
let admin;
let server;
let baseUrl;
let pool;
let config;
const ids = {};
let started;

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'viewas-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, superadmin = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', superadmin]
  )).rows[0].id;
  ids.boss = await user('boss', true);
  ids.other = await user('otherboss', true);
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  const app = express();
  app.use(express.json());
  app.use('/api/roles', require('../src/routes/roles'));
  app.use('/api/people', require('../src/routes/people'));
  app.use('/api/conversations', require('../src/routes/conversations'));
  app.use('/api/users', require('../src/routes/users'));
  app.use('/api/notes', require('../src/routes/notes'));
  app.use('/api/saved', require('../src/routes/saved'));
  app.use('/api/files', require('../src/routes/files'));
  app.use('/api/activity', require('../src/routes/activity'));
  app.use('/api/reminders', require('../src/routes/reminders'));
  app.use('/api/leave', require('../src/routes/leave'));
  app.use('/api/attendance', require('../src/routes/attendance'));
  app.use('/api/messages', require('../src/routes/messages'));
  app.use('/api/canvas', require('../src/routes/canvas'));
  app.use('/api/lists', require('../src/routes/lists'));
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
const tokenFor = (userId, extra = {}) => jwt.sign({ userId, username: 'u', tokenVersion: 0, ...extra }, config.JWT_SECRET);
const call = async (token, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('only an Owner can start View as, for a person who is not an Owner', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(tokenFor(ids.ann), 'POST', '/api/roles/view-as', { userId: ids.bob })).status, 403);
  assert.equal((await call(tokenFor(ids.boss), 'POST', '/api/roles/view-as', {})).status, 400);
  assert.equal((await call(tokenFor(ids.boss), 'POST', '/api/roles/view-as', { userId: ids.other })).status, 400, 'not another Owner');
  assert.equal((await call(tokenFor(ids.boss), 'POST', '/api/roles/view-as', { userId: 99999 })).status, 404);
  started = await call(tokenFor(ids.boss), 'POST', '/api/roles/view-as', { userId: ids.ann });
  assert.equal(started.status, 200);
  assert.equal(started.json.user.id, ids.ann);
  assert.equal(started.json.user.isSuperadmin, false);
  const claims = jwt.verify(started.json.token, config.JWT_SECRET);
  assert.equal(claims.userId, ids.ann);
  assert.equal(claims.viewAs, ids.boss);
  assert.ok(claims.exp - claims.iat <= 3600, 'one hour at most');
  ids.viewToken = started.json.token;
  started.json.full = started.json.full;
  const audit = await admin.query("SELECT actor_id, target_user_id FROM moderation_audit_log WHERE action = 'view_as_started'");
  assert.deepEqual(audit.rows, [{ actor_id: ids.boss, target_user_id: ids.ann }]);
});

test('while Pre-launch (testing), View as reads everything the person can, including private screens, and still refuses every write', async (t) => {
  if (skip(t)) return;
  assert.equal(started.json.full, true);
  assert.equal(jwt.verify(ids.viewToken, config.JWT_SECRET).viewFull, true);
  assert.equal((await call(ids.viewToken, 'GET', '/api/people')).status, 200);
  assert.equal((await call(ids.viewToken, 'GET', '/api/conversations')).status, 200, 'direct messages are shown in testing mode');
  const write = await call(ids.viewToken, 'POST', '/api/roles/view-as', { userId: ids.bob });
  assert.equal(write.status, 403);
  assert.match(write.json.error, /read-only/);
  assert.equal((await call(ids.viewToken, 'PUT', '/api/people/1', {})).status, 403);
  const audit = await admin.query("SELECT details FROM moderation_audit_log WHERE action = 'view_as_started'");
  assert.equal(audit.rows[0].details.includesPrivate, true, 'the audit log says private screens were included');
});

test('once the workspace is Live, View as goes back to what the roles decide and private things are refused again', async (t) => {
  if (skip(t)) return;
  await admin.query('UPDATE moderation_settings SET go_live = TRUE WHERE id = 1');
  try {
    assert.equal((await call(ids.viewToken, 'GET', '/api/people')).status, 200);
    // private screens come back as samples, never as the person's real content
    await admin.query("INSERT INTO direct_messages (sender_id, receiver_id, content) VALUES ($1, $2, 'REAL DM SECRET')", [ids.ann, ids.bob]);
    await admin.query("INSERT INTO notes (user_id, title, content) VALUES ($1, 'REAL NOTE SECRET', 'REAL NOTE SECRET')", [ids.ann]);
    for (const path of [`/api/users/${ids.bob}/direct-messages`, '/api/notes', '/api/saved', '/api/conversations', '/api/files', '/api/activity', '/api/reminders']) {
      const sampled = await call(ids.viewToken, 'GET', path);
      assert.equal(sampled.status, 200, path);
      assert.ok(!JSON.stringify(sampled.json).includes('SECRET'), `${path} shows no real content`);
    }
    const dm = await call(ids.viewToken, 'GET', `/api/users/${ids.bob}/direct-messages`);
    assert.ok(dm.json.messages.length >= 3 && dm.json.messages.every((m) => m.id < 0), 'a sample conversation');
    // leave and attendance: samples for their own screens, and the HR views stay refused
    const leave = await call(ids.viewToken, 'GET', '/api/leave/me');
    assert.equal(leave.status, 200);
    assert.ok(leave.json.balances.every((b) => b.typeId < 0) && leave.json.requests.every((r) => r.id < 0));
    const sheet = await call(ids.viewToken, 'GET', '/api/attendance/timesheet?month=2026-10');
    assert.equal(sheet.status, 200);
    assert.ok(sheet.json.days.length === 31 && sheet.json.totals.presentDays > 10, 'a month of sample days, worked out by the real rules');
    assert.equal((await call(ids.viewToken, 'GET', '/api/attendance/today')).status, 200);
    assert.equal((await call(ids.viewToken, 'GET', '/api/leave/records')).status, 403, 'HR views are refused');
    assert.equal((await call(ids.viewToken, 'GET', '/api/attendance/board')).status, 403);
    const fresh = await call(tokenFor(ids.boss), 'POST', '/api/roles/view-as', { userId: ids.ann });
    assert.equal(fresh.json.full, false);
    // real content never comes back: channel messages are made-up samples, and a channel the person is not in is still refused
    const inChannel = (await admin.query("INSERT INTO channels (name) VALUES ('demo-room') RETURNING id")).rows[0].id;
    const outChannel = (await admin.query("INSERT INTO channels (name) VALUES ('demo-secret') RETURNING id")).rows[0].id;
    await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [inChannel, ids.ann]);
    await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'REAL PRIVATE TEXT')", [inChannel, ids.ann]);
    const sample = await call(fresh.json.token, 'GET', `/api/messages/${inChannel}`);
    assert.equal(sample.status, 200);
    assert.ok(sample.json.messages.length >= 6);
    assert.ok(sample.json.messages.every((m) => m.id < 0 && !JSON.stringify(m).includes('REAL PRIVATE TEXT')), 'only samples');
    assert.equal((await call(fresh.json.token, 'GET', `/api/messages/${outChannel}`)).status, 403, 'their access still decides what opens');
    const canvas = await call(fresh.json.token, 'GET', `/api/canvas/channel/${inChannel}`);
    assert.match(canvas.json.canvas.title, /sample/i);
    assert.equal((await call(fresh.json.token, 'GET', '/api/lists')).json.lists.length, 0);
  } finally {
    await admin.query('UPDATE moderation_settings SET go_live = FALSE WHERE id = 1');
  }
});

test('the View as token stops working when the Owner who started it is no longer an Owner', async (t) => {
  if (skip(t)) return;
  await admin.query('UPDATE users SET is_superadmin = FALSE WHERE id = $1', [ids.boss]);
  assert.equal((await call(ids.viewToken, 'GET', '/api/people')).status, 403);
  await admin.query('UPDATE users SET is_superadmin = TRUE WHERE id = $1', [ids.boss]);
  assert.equal((await call(ids.viewToken, 'GET', '/api/people')).status, 200);
});
