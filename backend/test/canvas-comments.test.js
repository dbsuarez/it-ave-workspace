// Canvas comment threads against a real PostgreSQL (scratch database). Skipped when none is reachable.
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
  process.env.JWT_SECRET = 'canvas-comments-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name) => (await admin.query(
    'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [name, `${name}@x.test`, 'x']
  )).rows[0].id;
  ids.alice = await user('alice');
  ids.bob = await user('bob');
  ids.carol = await user('carol');
  ids.eve = await user('eve');
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

async function newCanvas() {
  const { json } = await call(ids.alice, 'POST', '', { title: 'Talk', content: '# Plan\n\nText' });
  const id = json.canvas.id;
  await call(ids.alice, 'POST', `/${id}/collaborators`, { username: 'bob', role: 'editor' });
  await call(ids.alice, 'POST', `/${id}/collaborators`, { username: 'carol', role: 'viewer' });
  return id;
}

test('editors comment with a quoted passage, reply, and everyone who can read sees the thread', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  emitted.length = 0;
  const first = await call(ids.alice, 'POST', `/${id}/comments`, { body: 'Is this the final plan?', anchor: '# Plan' });
  assert.equal(first.status, 201);
  assert.equal(first.json.comment.anchor, '# Plan');
  assert.equal(first.json.comment.author.username, 'alice');
  assert.deepEqual(emitted.at(-1), { room: `canvas:${id}`, event: 'canvas_comments_updated', payload: { canvasId: id } });
  const reply = await call(ids.bob, 'POST', `/${id}/comments`, { body: 'Yes', parentId: first.json.comment.id, anchor: 'ignored' });
  assert.equal(reply.status, 201);
  assert.equal(reply.json.comment.parentId, first.json.comment.id);
  assert.equal(reply.json.comment.anchor, null, 'a reply has no quote of its own');
  const seen = await call(ids.carol, 'GET', `/${id}/comments`);
  assert.equal(seen.status, 200, 'a viewer can read the thread');
  assert.deepEqual(seen.json.comments.map((c) => c.body), ['Is this the final plan?', 'Yes']);
});

test('who may do what', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  assert.equal((await call(ids.carol, 'POST', `/${id}/comments`, { body: 'hi' })).status, 403, 'a viewer cannot comment');
  assert.equal((await call(ids.eve, 'GET', `/${id}/comments`)).status, 404, 'a stranger sees nothing');
  assert.equal((await call(ids.eve, 'POST', `/${id}/comments`, { body: 'hi' })).status, 404);
  const bobs = (await call(ids.bob, 'POST', `/${id}/comments`, { body: 'bob says' })).json.comment;
  assert.equal((await call(ids.carol, 'DELETE', `/${id}/comments/${bobs.id}`)).status, 403);
  const own = (await call(ids.bob, 'POST', `/${id}/comments`, { body: 'mine' })).json.comment;
  assert.equal((await call(ids.bob, 'DELETE', `/${id}/comments/${own.id}`)).status, 200, 'the author can delete');
  assert.equal((await call(ids.alice, 'DELETE', `/${id}/comments/${bobs.id}`)).status, 200, 'the canvas owner can delete anyone\'s');
});

test('input is validated and bounded', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  assert.equal((await call(ids.alice, 'POST', `/${id}/comments`, { body: '   ' })).status, 400);
  assert.equal((await call(ids.alice, 'POST', `/${id}/comments`, { body: 'x'.repeat(2001) })).status, 400);
  assert.equal((await call(ids.alice, 'POST', `/${id}/comments`, { body: 'ok', anchor: 5 })).status, 400);
  assert.equal((await call(ids.alice, 'POST', `/${id}/comments`, { body: 'ok', parentId: 999999 })).status, 404);
  const long = await call(ids.alice, 'POST', `/${id}/comments`, { body: 'ok', anchor: 'a'.repeat(500) });
  assert.equal(long.json.comment.anchor.length, 200, 'the quote is trimmed');
  // replies must go to the top-level comment
  const top = long.json.comment;
  const reply = (await call(ids.alice, 'POST', `/${id}/comments`, { body: 'r', parentId: top.id })).json.comment;
  assert.equal((await call(ids.alice, 'POST', `/${id}/comments`, { body: 'rr', parentId: reply.id })).status, 400);
  // a thread of another canvas is not reachable through this one
  const other = await newCanvas();
  assert.equal((await call(ids.alice, 'POST', `/${other}/comments`, { body: 'x', parentId: top.id })).status, 404);
});

test('a thread can be resolved and reopened, and deleting it removes its replies', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  const top = (await call(ids.alice, 'POST', `/${id}/comments`, { body: 'question' })).json.comment;
  const reply = (await call(ids.bob, 'POST', `/${id}/comments`, { body: 'answer', parentId: top.id })).json.comment;
  assert.equal((await call(ids.bob, 'PATCH', `/${id}/comments/${reply.id}`, { resolved: true })).status, 400, 'only the whole thread');
  const done = await call(ids.bob, 'PATCH', `/${id}/comments/${top.id}`, { resolved: true });
  assert.equal(done.json.comment.resolved, true);
  assert.equal(done.json.comment.resolvedBy.username, 'bob');
  assert.equal((await call(ids.carol, 'PATCH', `/${id}/comments/${top.id}`, { resolved: false })).status, 403, 'viewers cannot');
  const reopened = await call(ids.alice, 'PATCH', `/${id}/comments/${top.id}`, { resolved: false });
  assert.equal(reopened.json.comment.resolved, false);
  assert.equal((await call(ids.alice, 'PATCH', `/${id}/comments/${top.id}`, { resolved: 'yes' })).status, 400);
  assert.equal((await call(ids.alice, 'DELETE', `/${id}/comments/${top.id}`)).status, 200);
  const left = await admin.query('SELECT COUNT(*) AS n FROM canvas_comments WHERE canvas_id = $1', [id]);
  assert.equal(Number(left.rows[0].n), 0, 'the reply went with it');
});

test('deleting the canvas deletes its comments', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  await call(ids.alice, 'POST', `/${id}/comments`, { body: 'bye' });
  await call(ids.alice, 'DELETE', `/${id}`);
  assert.equal((await call(ids.alice, 'GET', `/${id}/comments`)).status, 404, 'a deleted canvas shows nothing');
  await admin.query("UPDATE canvases SET deleted_at = NOW() - INTERVAL '30 days' WHERE id = $1", [id]);
  await require('../src/canvasTrash').purgeExpiredCanvases(require('../src/db').query);
  const left = await admin.query('SELECT COUNT(*) AS n FROM canvas_comments WHERE canvas_id = $1', [id]);
  assert.equal(Number(left.rows[0].n), 0);
});
