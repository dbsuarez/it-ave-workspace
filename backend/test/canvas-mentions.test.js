// Notifications for @mentions in canvases and for replies to comments. The pure helpers run anywhere; the
// rest needs a real PostgreSQL (scratch database) and is skipped when none is reachable.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');
const { extractMentions, addedMentions, snippetFor } = require('../src/canvasMentions');

test('mentions are found in text but not in code, emails or the middle of words', () => {
  assert.deepEqual(extractMentions('Hi @Ann and @bob_smith, (@carol) see `@code` and mail ann@example.com'), ['ann', 'bob_smith', 'carol']);
  assert.deepEqual(extractMentions('```\n@fenced\n```\nafter @real.'), ['real'], 'a final full stop is not part of the name');
  assert.deepEqual(extractMentions('@a-b.c and @a-b.c again'), ['a-b.c'], 'unique');
  assert.deepEqual(extractMentions(''), []);
  assert.deepEqual(extractMentions(null), []);
});

test('only mentions added by an edit count', () => {
  assert.deepEqual(addedMentions('Hi @ann', 'Hi @ann and @bob'), ['bob']);
  assert.deepEqual(addedMentions('Hi @ann', 'Hi @ANN, more text'), [], 'case does not matter');
  assert.deepEqual(addedMentions('', '@ann'), ['ann']);
  assert.deepEqual(addedMentions('@ann @bob', 'nobody'), []);
});

test('the preview is the line with the mention, as plain text', () => {
  assert.equal(snippetFor('# Plan\n\n- [ ] ask @ann to review **this**\n\nother', 'ann'), 'ask @ann to review this');
  assert.equal(snippetFor('x'.repeat(300) + ' @ann', 'ann').length, 160);
  assert.equal(snippetFor('nothing here', 'ann'), '');
});

let scratch;
let admin;
let server;
let baseUrl;
let pool;
let config;
const ids = {};
const pushed = [];

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'canvas-mentions-secret';
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
    req.io = { to: (room) => ({ emit: (event, payload) => pushed.push({ room, event, payload }) }) };
    next();
  });
  app.use('/api/canvas', require('../src/routes/canvas'));
  app.use('/api/activity', require('../src/routes/activity'));
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
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const settle = () => new Promise((resolve) => setTimeout(resolve, 250)); // notifications are sent after the reply
const rows = async (userId) => (await admin.query('SELECT * FROM canvas_mentions WHERE user_id = $1 ORDER BY id', [userId])).rows;

async function newCanvas() {
  const { json } = await call(ids.alice, 'POST', '/api/canvas', { title: 'Team page', content: 'start' });
  const id = json.canvas.id;
  await call(ids.alice, 'POST', `/api/canvas/${id}/collaborators`, { username: 'bob', role: 'editor' });
  await call(ids.alice, 'POST', `/api/canvas/${id}/collaborators`, { username: 'carol', role: 'viewer' });
  return id;
}

test('a new @mention in the text notifies that person, once', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  pushed.length = 0;
  await call(ids.alice, 'PATCH', `/api/canvas/${id}`, { content: 'Ask @bob to review the plan' });
  await settle();
  const mine = await rows(ids.bob);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].source, 'content');
  assert.equal(mine[0].actor_id, ids.alice);
  assert.equal(mine[0].snippet, 'Ask @bob to review the plan');
  const event = pushed.find((p) => p.room === `user_${ids.bob}`);
  assert.equal(event.event, 'canvas_activity');
  assert.equal(event.payload.type, 'canvas_mention');
  assert.equal(event.payload.canvasTitle, 'Team page');
  assert.equal(event.payload.actorUsername, 'alice');
  // saving again with the same mention, or just more text, does not repeat it
  await call(ids.alice, 'PATCH', `/api/canvas/${id}`, { content: 'Ask @bob to review the plan today' });
  await call(ids.alice, 'PATCH', `/api/canvas/${id}`, { title: 'Renamed' });
  await settle();
  assert.equal((await rows(ids.bob)).length, 1);
  // a viewer can be mentioned too
  await call(ids.alice, 'PATCH', `/api/canvas/${id}`, { content: 'Ask @bob to review the plan today. cc @carol' });
  await settle();
  assert.equal((await rows(ids.carol)).length, 1);
});

test('nobody is told about a canvas they cannot read, or about mentioning themselves', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  await call(ids.alice, 'PATCH', `/api/canvas/${id}`, { content: 'note for @eve, and @alice, and @nobody_here' });
  await settle();
  assert.equal((await rows(ids.eve)).length, 0, 'no access to the canvas');
  assert.equal((await rows(ids.alice)).length, 0, 'not told about their own mention');
});

test('comments notify the people mentioned and the author of the thread replied to', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  const top = (await call(ids.bob, 'POST', `/api/canvas/${id}/comments`, { body: 'Is this final?' })).json.comment;
  await settle();
  assert.equal((await rows(ids.alice)).length, 0, 'a new thread has nobody to tell');
  await call(ids.alice, 'POST', `/api/canvas/${id}/comments`, { body: 'Yes, thanks', parentId: top.id });
  await settle();
  const reply = (await rows(ids.bob)).find((r) => r.source === 'reply');
  assert.ok(reply, 'the thread author is told about a reply');
  assert.equal(reply.snippet, 'Yes, thanks');
  // a reply that also mentions the thread author is one notification, as a mention
  const before = (await rows(ids.bob)).length;
  await call(ids.alice, 'POST', `/api/canvas/${id}/comments`, { body: '@bob and @carol please check', parentId: top.id });
  await settle();
  const after = await rows(ids.bob);
  assert.equal(after.length, before + 1, 'not told twice');
  assert.equal(after[after.length - 1].source, 'comment');
  assert.ok((await rows(ids.carol)).some((r) => r.source === 'comment'));
});

test('the Activity feed lists canvas mentions and drops them when access is lost or the canvas is gone', async (t) => {
  if (skip(t)) return;
  const id = await newCanvas();
  await call(ids.alice, 'PATCH', `/api/canvas/${id}`, { content: 'for @bob in the feed' });
  await settle();
  const feed = (await call(ids.bob, 'GET', '/api/activity')).json;
  const item = feed.items.find((i) => i.type === 'canvas_mention' && i.canvasId === id);
  assert.ok(item, 'it is in the feed');
  assert.equal(item.canvasTitle, 'Team page');
  assert.equal(item.canvasKind, 'standalone');
  assert.equal(item.source, 'content');
  assert.equal(item.actorUsername, 'alice');
  assert.equal(item.unseen, true);
  assert.ok(feed.unseenCount >= 1);
  assert.ok((await call(ids.bob, 'GET', '/api/activity?type=mention')).json.items.some((i) => i.canvasId === id), 'it counts as a mention');
  assert.ok(!(await call(ids.bob, 'GET', '/api/activity?type=reply')).json.items.some((i) => i.canvasId === id), 'but not as a reply');
  assert.ok(!(await call(ids.eve, 'GET', '/api/activity')).json.items.some((i) => i.canvasId === id), 'nobody else sees it');
  // marking the feed seen clears the count
  await call(ids.bob, 'POST', '/api/activity/seen');
  assert.equal((await call(ids.bob, 'GET', '/api/activity')).json.unseenCount, 0);
  // lose access
  await call(ids.alice, 'DELETE', `/api/canvas/${id}/collaborators/${ids.bob}`);
  assert.ok(!(await call(ids.bob, 'GET', '/api/activity')).json.items.some((i) => i.canvasId === id), 'no access, no item');
  await call(ids.alice, 'POST', `/api/canvas/${id}/collaborators`, { username: 'bob', role: 'editor' });
  assert.ok((await call(ids.bob, 'GET', '/api/activity')).json.items.some((i) => i.canvasId === id), 'access back, item back');
  // deleted canvases drop out
  await call(ids.alice, 'DELETE', `/api/canvas/${id}`);
  assert.ok(!(await call(ids.bob, 'GET', '/api/activity')).json.items.some((i) => i.canvasId === id));
});
