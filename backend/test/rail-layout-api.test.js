// The rail an Owner arranges for everyone, through the settings routes (real PostgreSQL, scratch database).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let pool; let server; let baseUrl; let config;
const ids = {};
const emitted = [];

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'rail-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  ids.owner = (await admin.query("INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ('rail-owner', 'ro@x.test', 'x', TRUE) RETURNING id")).rows[0].id;
  ids.member = (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ('rail-member', 'rm@x.test', 'x') RETURNING id")).rows[0].id;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = { emit: (event) => emitted.push(event) }; next(); });
  app.use('/api/settings', require('../src/routes/settings'));
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
const call = async (user, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/settings${path}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[user], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('until an Owner arranges it, everyone gets the default rail, with Lists in More', async (t) => {
  if (skip(t)) return;
  const rail = (await call('member', 'GET', '/sidebar')).json.layout.rail;
  assert.equal(rail.order[0], 'home');
  assert.deepEqual(rail.more, ['lists']);
  assert.equal((await call('member', 'GET', '/sidebar')).json.layout.canManageWorkspaceSections, false);
});

test('only someone who manages the workspace can arrange it, and then everyone sees that rail', async (t) => {
  if (skip(t)) return;
  const wanted = { order: ['home', 'knowledgebase', 'people', 'dms', 'activity'], more: ['sheets', 'lists', 'drawings'] };
  assert.equal((await call('member', 'PUT', '/sidebar/rail', wanted)).status, 403);
  emitted.length = 0;
  const saved = await call('owner', 'PUT', '/sidebar/rail', wanted);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.rail.order.slice(0, 5), wanted.order);
  assert.deepEqual(saved.json.rail.more, wanted.more);
  assert.ok(emitted.includes('workspace_sections_updated'), 'everyone is told, so their rail changes at once');
  const seen = (await call('member', 'GET', '/sidebar')).json.layout.rail;
  assert.deepEqual(seen.order.slice(0, 5), wanted.order, 'an employee gets the Owner\'s order');
  assert.deepEqual(seen.more, wanted.more);
  assert.deepEqual([...seen.order, ...seen.more].sort(), ['activity', 'canvas2', 'dms', 'drawings', 'files', 'home', 'huddle', 'knowledgebase', 'later', 'lists', 'moderation', 'notes', 'people', 'sheets'].sort());
  assert.equal((await call('owner', 'GET', '/sidebar')).json.layout.canManageWorkspaceSections, true);
});

test('what is sent is cleaned: Home cannot leave the rail, unknown names are dropped; and the channel sections are left alone', async (t) => {
  if (skip(t)) return;
  const before = (await admin.query('SELECT workspace_sidebar_layout FROM moderation_settings WHERE id = 1')).rows[0].workspace_sidebar_layout;
  const saved = await call('owner', 'PUT', '/sidebar/rail', { order: ['dms', 'bogus'], more: ['home', 'files'] });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.rail.order[0], 'home');
  assert.equal(saved.json.rail.more.includes('home'), false);
  assert.equal(saved.json.rail.order.includes('bogus'), false);
  const after = (await admin.query('SELECT workspace_sidebar_layout FROM moderation_settings WHERE id = 1')).rows[0].workspace_sidebar_layout;
  assert.deepEqual(after, before, 'the workspace channel sections are not touched');
  assert.equal((await call('owner', 'PUT', '/sidebar/rail', 'nonsense')).status, 400, 'a body that is not an arrangement is refused');
});

test('resetting gives everyone the default again', async (t) => {
  if (skip(t)) return;
  const reset = await call('owner', 'DELETE', '/sidebar/rail');
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.json.rail.more, ['lists']);
  assert.deepEqual((await call('member', 'GET', '/sidebar')).json.layout.rail.more, ['lists']);
  assert.equal((await call('member', 'DELETE', '/sidebar/rail')).status, 403);
});
