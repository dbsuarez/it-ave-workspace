// Canvas history against a real PostgreSQL (scratch database). Skipped when none is reachable.
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
  process.env.JWT_SECRET = 'canvas-history-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name) => (await admin.query(
    'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [name, `${name}@x.test`, 'x']
  )).rows[0].id;
  ids.alice = await user('alice');
  ids.bob = await user('bob');
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

const as = (userId) => ({
  Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`,
  'Content-Type': 'application/json',
});
const call = async (userId, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/canvas${path}`, { method, headers: as(userId), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

async function newCanvas(content = 'first') {
  const { json } = await call(ids.alice, 'POST', '', { title: 'History', content });
  await call(ids.alice, 'POST', `/${json.canvas.id}/collaborators`, { username: 'bob', role: 'editor' });
  return json.canvas;
}

test('saves are recorded, and quick saves by one person fold into one entry', async (t) => {
  if (skip(t)) return;
  const canvas = await newCanvas();
  for (const text of ['a', 'ab', 'abc']) {
    assert.equal((await call(ids.alice, 'PATCH', `/${canvas.id}`, { content: text })).status, 200);
  }
  let history = (await call(ids.alice, 'GET', `/${canvas.id}/revisions`)).json.revisions;
  assert.equal(history.length, 1, 'three autosaves in a minute are one entry');
  assert.equal(history[0].editedBy.username, 'alice');
  assert.equal(history[0].revision, 4, 'it points at the latest of them');
  // someone else's save is a separate entry
  await call(ids.bob, 'PATCH', `/${canvas.id}`, { content: 'abc from bob' });
  history = (await call(ids.alice, 'GET', `/${canvas.id}/revisions`)).json.revisions;
  assert.deepEqual(history.map((h) => h.editedBy.username), ['bob', 'alice'], 'newest first');
  const body = (await call(ids.alice, 'GET', `/${canvas.id}/revisions/${history[1].revision}`)).json.revision;
  assert.equal(body.content, 'abc');
  // after the window, the same person starts a new entry
  await admin.query("UPDATE canvas_revisions SET edited_at = NOW() - INTERVAL '5 minutes' WHERE canvas_id = $1", [canvas.id]);
  await call(ids.bob, 'PATCH', `/${canvas.id}`, { content: 'later edit' });
  assert.equal((await call(ids.alice, 'GET', `/${canvas.id}/revisions`)).json.revisions.length, 3);
});

test('restoring an old version saves it as a new one and broadcasts it', async (t) => {
  if (skip(t)) return;
  const canvas = await newCanvas('v0');
  await call(ids.alice, 'PATCH', `/${canvas.id}`, { content: 'version A', title: 'Title A' });
  await call(ids.bob, 'PATCH', `/${canvas.id}`, { content: 'version B', title: 'Title B' });
  const history = (await call(ids.alice, 'GET', `/${canvas.id}/revisions`)).json.revisions;
  const aRevision = history[1].revision;
  emitted.length = 0;
  const restored = await call(ids.alice, 'POST', `/${canvas.id}/revisions/${aRevision}/restore`, {});
  assert.equal(restored.status, 200);
  assert.equal(restored.json.canvas.content, 'version A');
  assert.equal(restored.json.canvas.title, 'Title A');
  assert.equal(restored.json.canvas.revision, 4, 'a restore is a new revision, nothing is erased');
  assert.equal(emitted.find((e) => e.event === 'canvas_updated').payload.content, 'version A');
  const after = (await call(ids.alice, 'GET', `/${canvas.id}/revisions`)).json.revisions;
  assert.ok(after.some((r) => r.revision === 4), 'the restore itself is in the history');
  // the version that was replaced is still there, so a restore can be undone
  const bRevision = after.find((r) => r.title === 'Title B');
  assert.ok(bRevision, 'version B is still available');
  // a stale base revision is refused like any other save
  assert.equal((await call(ids.alice, 'POST', `/${canvas.id}/revisions/${aRevision}/restore`, { baseRevision: 1 })).status, 409);
  assert.equal((await call(ids.alice, 'POST', `/${canvas.id}/revisions/999/restore`, {})).status, 404);
});

test('a restore by the same person right after their own edit still keeps the replaced version', async (t) => {
  if (skip(t)) return;
  const canvas = await newCanvas('v0');
  await call(ids.alice, 'PATCH', `/${canvas.id}`, { content: 'first draft' });
  await admin.query("UPDATE canvas_revisions SET edited_at = NOW() - INTERVAL '5 minutes' WHERE canvas_id = $1", [canvas.id]);
  await call(ids.alice, 'PATCH', `/${canvas.id}`, { content: 'second draft' });
  const before = (await call(ids.alice, 'GET', `/${canvas.id}/revisions`)).json.revisions;
  assert.equal(before.length, 2);
  const restored = await call(ids.alice, 'POST', `/${canvas.id}/revisions/${before[1].revision}/restore`, {});
  assert.equal(restored.json.canvas.content, 'first draft');
  const after = (await call(ids.alice, 'GET', `/${canvas.id}/revisions`)).json.revisions;
  assert.equal(after.length, 3, 'the restore is its own entry');
  const texts = [];
  for (const r of after) texts.push((await call(ids.alice, 'GET', `/${canvas.id}/revisions/${r.revision}`)).json.revision.content);
  assert.deepEqual(texts, ['first draft', 'second draft', 'first draft'], 'the replaced version is still there to go back to');
});

test('history follows the canvas access rules', async (t) => {
  if (skip(t)) return;
  const canvas = await newCanvas();
  await call(ids.alice, 'PATCH', `/${canvas.id}`, { content: 'secret' });
  assert.equal((await call(ids.eve, 'GET', `/${canvas.id}/revisions`)).status, 404, 'strangers see nothing');
  assert.equal((await call(ids.eve, 'GET', `/${canvas.id}/revisions/2`)).status, 404);
  assert.equal((await call(ids.eve, 'POST', `/${canvas.id}/revisions/2/restore`, {})).status, 404);
  await call(ids.alice, 'POST', `/${canvas.id}/collaborators`, { username: 'eve', role: 'viewer' });
  assert.equal((await call(ids.eve, 'GET', `/${canvas.id}/revisions`)).status, 200, 'a viewer can read history');
  assert.equal((await call(ids.eve, 'POST', `/${canvas.id}/revisions/2/restore`, {})).status, 403, 'but not restore');
});

test('only the newest 100 versions are kept, and deleting the canvas deletes its history', async (t) => {
  if (skip(t)) return;
  const canvas = await newCanvas();
  // alternate editors so every save is its own entry
  for (let i = 0; i < 104; i += 1) {
    await call(i % 2 === 0 ? ids.alice : ids.bob, 'PATCH', `/${canvas.id}`, { content: `edit ${i}` });
  }
  const history = (await call(ids.alice, 'GET', `/${canvas.id}/revisions`)).json.revisions;
  assert.equal(history.length, 100);
  assert.equal(history[0].revision, 105);
  const count = await admin.query('SELECT COUNT(*) AS n FROM canvas_revisions WHERE canvas_id = $1', [canvas.id]);
  assert.equal(Number(count.rows[0].n), 100);
  await call(ids.alice, 'DELETE', `/${canvas.id}`);
  await admin.query("UPDATE canvases SET deleted_at = NOW() - INTERVAL '30 days' WHERE id = $1", [canvas.id]);
  await require('../src/canvasTrash').purgeExpiredCanvases(require('../src/db').query);
  const gone = await admin.query('SELECT COUNT(*) AS n FROM canvas_revisions WHERE canvas_id = $1', [canvas.id]);
  assert.equal(Number(gone.rows[0].n), 0);
});

test('sections can include their full text for rendering', async (t) => {
  if (skip(t)) return;
  const canvas = await newCanvas('# Title\n\n- [ ] one\n- [x] two');
  const light = (await call(ids.alice, 'GET', `/${canvas.id}/sections`)).json;
  assert.equal(light.sections[0].text, undefined);
  const full = (await call(ids.alice, 'GET', `/${canvas.id}/sections?full=true`)).json;
  assert.equal(full.sections[0].text, '# Title');
  assert.equal(full.sections[1].text, '- [ ] one\n- [x] two');
  assert.equal(full.revision, 1);
});
