// The comment-only canvas role and "request edit access", against a real PostgreSQL (scratch database).
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
const emitted = [];

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'canvas-commenter-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name) => (await admin.query(
    'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [name, `${name}@x.test`, 'x']
  )).rows[0].id;
  ids.alice = await user('alice');
  ids.bob = await user('bob');
  ids.carol = await user('carol');
  ids.dave = await user('dave');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
    next();
  });
  app.use('/api/canvas', require('../src/routes/canvas'));
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
  const res = await fetch(`${baseUrl}/api/canvas${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

test('a commenter can read and comment, but not edit, resolve or share', async (t) => {
  if (skip(t)) return;
  const { json } = await call(ids.alice, 'POST', '', { title: 'Plan', content: 'Text' });
  const id = json.canvas.id;
  assert.equal((await call(ids.alice, 'POST', `/${id}/collaborators`, { username: 'bob', role: 'commenter' })).json.collaborator.role, 'commenter');
  assert.equal((await call(ids.alice, 'POST', `/${id}/collaborators`, { username: 'carol', role: 'viewer' })).status, 200);

  const read = await call(ids.bob, 'GET', `/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.canvas.myRole, 'commenter');

  const posted = await call(ids.bob, 'POST', `/${id}/comments`, { body: 'Looks good' });
  assert.equal(posted.status, 201);
  assert.equal((await call(ids.carol, 'POST', `/${id}/comments`, { body: 'me too' })).status, 403, 'a viewer still cannot comment');

  assert.equal((await call(ids.bob, 'PATCH', `/${id}`, { content: 'changed', revision: read.json.canvas.revision })).status, 403);
  assert.equal((await call(ids.bob, 'PATCH', `/${id}/comments/${posted.json.comment.id}`, { resolved: true })).status, 403, 'resolving needs edit access');
  assert.equal((await call(ids.bob, 'POST', `/${id}/collaborators`, { username: 'dave', role: 'viewer' })).status, 403);
  assert.equal((await call(ids.bob, 'DELETE', `/${id}/comments/${posted.json.comment.id}`)).status, 200, 'their own comment can go');
});

test('sharing with a channel can be comment-only, and the best role wins', async (t) => {
  if (skip(t)) return;
  const channel = (await admin.query("INSERT INTO channels (name, created_by) VALUES ('team', $1) RETURNING id", [ids.alice])).rows[0].id;
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)', [channel, ids.alice, ids.dave]);
  const { json } = await call(ids.alice, 'POST', '', { title: 'Team notes', content: 'x' });
  const id = json.canvas.id;
  assert.equal((await call(ids.alice, 'PUT', `/${id}/channels/${channel}`, { role: 'commenter' })).status, 200);
  assert.equal((await call(ids.dave, 'GET', `/${id}`)).json.canvas.myRole, 'commenter');
  assert.equal((await call(ids.dave, 'POST', `/${id}/comments`, { body: 'from the channel' })).status, 201);
  assert.equal((await call(ids.alice, 'PUT', `/${id}/channels/${channel}`, { role: 'nonsense' })).status, 400);
});

test('someone who can only read asks the owner for edit access, once an hour', async (t) => {
  if (skip(t)) return;
  const { json } = await call(ids.alice, 'POST', '', { title: 'Budget', content: 'x' });
  const id = json.canvas.id;
  await call(ids.alice, 'POST', `/${id}/collaborators`, { username: 'carol', role: 'viewer' });
  await call(ids.alice, 'POST', `/${id}/collaborators`, { username: 'bob', role: 'editor' });

  emitted.length = 0;
  const asked = await call(ids.carol, 'POST', `/${id}/access-request`, { message: 'Can I edit the totals?' });
  assert.equal(asked.status, 200);
  const told = emitted.find((e) => e.event === 'canvas_activity' && e.room === `user_${ids.alice}`);
  assert.ok(told, 'the owner is told');
  assert.equal(told.payload.source, 'access');
  assert.equal(told.payload.preview, 'Can I edit the totals?');

  assert.equal((await call(ids.carol, 'POST', `/${id}/access-request`, {})).status, 429, 'not again within the hour');
  assert.equal((await call(ids.bob, 'POST', `/${id}/access-request`, {})).status, 400, 'an editor has nothing to ask for');
  assert.equal((await call(ids.alice, 'POST', `/${id}/access-request`, {})).status, 400, 'nor the owner');
  assert.equal((await call(ids.dave, 'POST', `/${id}/access-request`, {})).status, 404, 'a stranger cannot even see it');

  const feed = await admin.query("SELECT source FROM canvas_mentions WHERE user_id = $1 AND canvas_id = $2", [ids.alice, id]);
  assert.deepEqual(feed.rows.map((r) => r.source), ['access']);
});
