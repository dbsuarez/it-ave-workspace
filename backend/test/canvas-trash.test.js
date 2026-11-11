// Deleted personal canvases go to the trash and can be restored; against a real PostgreSQL (scratch database).
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
let trash;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'canvas-trash-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  trash = require('../src/canvasTrash');
  const user = async (name) => (await admin.query(
    'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [name, `${name}@x.test`, 'x']
  )).rows[0].id;
  ids.alice = await user('alice');
  ids.bob = await user('bob');
  ids.eve = await user('eve');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }) }; next(); });
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
const dbQuery = () => require('../src/db').query;

async function newCanvas(title = 'Plan') {
  const { json } = await call(ids.alice, 'POST', '', { title, content: '# Important\n\nDo not lose this.' });
  const id = json.canvas.id;
  await call(ids.alice, 'POST', `/${id}/collaborators`, { username: 'bob', role: 'editor' });
  return id;
}

test('deleting a personal canvas hides it everywhere but keeps it for restoring', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  await call(ids.alice, 'POST', `/${id}/comments`, { body: 'a comment' });
  const del = await call(ids.alice, 'DELETE', `/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.restorable, true);
  assert.equal(del.json.retentionDays, config.CANVAS_TRASH_DAYS);
  // gone for the owner and for the collaborator
  for (const who of [ids.alice, ids.bob]) {
    assert.equal((await call(who, 'GET', `/${id}`)).status, 404);
    assert.ok(!(await call(who, 'GET', '/standalone')).json.canvases.some((c) => c.id === id), 'not in the list');
  }
  assert.equal((await call(ids.alice, 'PATCH', `/${id}`, { content: 'x' })).status, 404, 'cannot be edited while deleted');
  // still in the database
  const row = await admin.query('SELECT deleted_at, deleted_by FROM canvases WHERE id = $1', [id]);
  assert.ok(row.rows[0].deleted_at);
  assert.equal(row.rows[0].deleted_by, ids.alice);
});

test('the owner sees the trash, and nobody else does', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas('Quarterly');
  await call(ids.alice, 'DELETE', `/${id}`);
  const mine = (await call(ids.alice, 'GET', '/deleted')).json;
  assert.equal(mine.retentionDays, config.CANVAS_TRASH_DAYS);
  const entry = mine.canvases.find((c) => c.id === id);
  assert.equal(entry.title, 'Quarterly');
  assert.match(entry.preview, /Important/);
  assert.ok(new Date(entry.expiresAt) > new Date(entry.deletedAt));
  assert.ok(!(await call(ids.bob, 'GET', '/deleted')).json.canvases.some((c) => c.id === id), 'a collaborator does not see it');
  assert.ok(!(await call(ids.eve, 'GET', '/deleted')).json.canvases.some((c) => c.id === id));
});

test('restoring brings back the canvas, its comments and its history', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas('Restore me');
  await call(ids.alice, 'PATCH', `/${id}`, { content: 'second version' });
  await call(ids.alice, 'POST', `/${id}/comments`, { body: 'still here' });
  await call(ids.alice, 'DELETE', `/${id}`);
  const back = await call(ids.alice, 'POST', `/${id}/restore`);
  assert.equal(back.status, 200);
  assert.equal(back.json.canvas.content, 'second version');
  assert.equal(back.json.canvas.myRole, 'owner');
  assert.ok((await call(ids.alice, 'GET', '/standalone')).json.canvases.some((c) => c.id === id));
  assert.equal((await call(ids.bob, 'GET', `/${id}`)).status, 200, 'the collaborator has access again');
  assert.equal((await call(ids.alice, 'GET', `/${id}/comments`)).json.comments[0].body, 'still here');
  assert.ok((await call(ids.alice, 'GET', `/${id}/revisions`)).json.revisions.length >= 1);
  assert.ok(!(await call(ids.alice, 'GET', '/deleted')).json.canvases.some((c) => c.id === id), 'out of the trash');
});

test('only the owner can restore, and only a deleted canvas', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  assert.equal((await call(ids.alice, 'POST', `/${id}/restore`)).status, 404, 'not deleted');
  await call(ids.alice, 'DELETE', `/${id}`);
  assert.equal((await call(ids.bob, 'POST', `/${id}/restore`)).status, 404, 'a collaborator cannot');
  assert.equal((await call(ids.eve, 'POST', `/${id}/restore`)).status, 404, 'a stranger cannot');
  assert.equal((await call(ids.alice, 'POST', `/${id}/restore`)).status, 200);
  assert.equal((await call(ids.alice, 'POST', `/${id}/restore`)).status, 404, 'a second restore has nothing to do');
  assert.equal((await call(ids.alice, 'POST', '/abc/restore')).status, 400);
});

test('a canvas deleted too long ago cannot be restored, and the purge removes only expired ones', async (t) => {
  if (skip(t)) return;
  const old = await newCanvas('old');
  const fresh = await newCanvas('fresh');
  await call(ids.alice, 'DELETE', `/${old}`);
  await call(ids.alice, 'DELETE', `/${fresh}`);
  await admin.query("UPDATE canvases SET deleted_at = NOW() - INTERVAL '30 days' WHERE id = $1", [old]);
  assert.equal((await call(ids.alice, 'POST', `/${old}/restore`)).status, 410);
  assert.ok(!(await call(ids.alice, 'GET', '/deleted')).json.canvases.some((c) => c.id === old), 'not listed any more');
  const removed = await trash.purgeExpiredCanvases(dbQuery());
  assert.ok(removed >= 1);
  assert.equal((await admin.query('SELECT COUNT(*) AS n FROM canvases WHERE id = $1', [old])).rows[0].n, '0');
  assert.equal((await admin.query('SELECT COUNT(*) AS n FROM canvases WHERE id = $1', [fresh])).rows[0].n, '1', 'a recent one is kept');
  assert.equal((await call(ids.alice, 'POST', `/${fresh}/restore`)).status, 200);
});

test('channel canvases are still removed at once', async (t) => {
  if (skip(t)) return;
  const channel = (await admin.query("INSERT INTO channels (name, created_by) VALUES ('trash-test', $1) RETURNING id", [ids.alice])).rows[0].id;
  await admin.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'moderator')", [channel, ids.alice]);
  const made = await call(ids.alice, 'GET', `/channel/${channel}`);
  assert.equal(made.status, 200);
  const canvasId = made.json.canvas.id;
  const del = await call(ids.alice, 'DELETE', `/${canvasId}`);
  assert.equal(del.status, 200);
  assert.notEqual(del.json.restorable, true);
  assert.equal((await admin.query('SELECT COUNT(*) AS n FROM canvases WHERE id = $1', [canvasId])).rows[0].n, '0');
});
