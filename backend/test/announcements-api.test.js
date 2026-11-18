// Announcements from the dialog: the same rules as /announce (an announcement channel, the Announce permission, an open channel).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config;
const ids = {};
const emitted = [];
const fakeIo = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }), emit: (event, payload) => emitted.push({ room: null, event, payload }), in: () => ({ fetchSockets: async () => [] }) };

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'announce-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const add = async (name, type = 'member') => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', type])).rows[0].id;
  for (const name of ['poster', 'plain', 'outsider', 'other']) ids[name] = await add(`an-${name}`);
  ids.guest = await add('an-guest', 'guest');
  const role = (await admin.query("INSERT INTO roles (name, permissions) VALUES ('an-announcers', '{announce}') RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.poster, role]);
  const channel = async (name, scope) => {
    const id = (await admin.query('INSERT INTO channels (name, command_scope) VALUES ($1, $2) RETURNING id', [name, scope])).rows[0].id;
    for (const user of ['poster', 'plain', 'other']) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [id, ids[user]]);
    await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [id, ids.guest]);
    return id;
  };
  ids.news = await channel('an-news', 'announcements');
  ids.chat = await channel('an-chat', null);
  ids.old = await channel('an-old', 'announcements');
  await admin.query('UPDATE channels SET archived_at = NOW() WHERE id = $1', [ids.old]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = fakeIo; next(); });
  app.use('/api/announcements', require('../src/routes/announcements'));
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
async function post(user, body) {
  const response = await fetch(`${baseUrl}/api/announcements`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[user], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const count = async (channelId) => (await admin.query("SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = $1 AND kind = 'announcement'", [channelId])).rows[0].n;

test('someone with the Announce permission posts an announcement, text exactly as written, and the channel is told', async (t) => {
  if (skip(t)) return;
  const before = emitted.length;
  const made = await post('poster', { channelId: ids.news, text: '  Office closed on Friday.\n\nSee you Monday!  ' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const row = (await admin.query("SELECT kind, content, user_id FROM messages WHERE channel_id = $1", [ids.news])).rows;
  assert.deepEqual(row.map((r) => [r.kind, r.content, r.user_id]), [['announcement', 'Office closed on Friday.\n\nSee you Monday!', ids.poster]]);
  assert.ok(emitted.slice(before).some((e) => e.event === 'new_message' && e.payload.kind === 'announcement'), 'the channel gets the message');
  assert.equal(made.json.message.kind, 'announcement');
});

test('people without the permission, outsiders and guests are refused, and nothing is posted', async (t) => {
  if (skip(t)) return;
  const had = await count(ids.news);
  for (const user of ['plain', 'outsider', 'guest']) assert.equal((await post(user, { channelId: ids.news, text: 'Hi' })).status, 403, user);
  assert.equal(await count(ids.news), had);
});

test('only an announcement channel takes announcements, and an archived one is read-only', async (t) => {
  if (skip(t)) return;
  const refused = await post('poster', { channelId: ids.chat, text: 'Hi' });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /announcement channel/i);
  assert.equal((await post('poster', { channelId: ids.old, text: 'Hi' })).status, 409);
  assert.equal(await count(ids.chat), 0);
  assert.equal(await count(ids.old), 0);
});

test('an empty, missing, non-text or too long announcement is refused', async (t) => {
  if (skip(t)) return;
  const had = await count(ids.news);
  for (const text of ['', '   \n  ', undefined, 5, null, 'x'.repeat(2001)]) {
    assert.equal((await post('poster', { channelId: ids.news, text })).status, 400, String(text).slice(0, 20));
  }
  assert.equal((await post('poster', { channelId: ids.news, text: 'x'.repeat(2000) })).status, 201, 'exactly 2000 is fine');
  assert.equal(await count(ids.news), had + 1);
});

test('a missing or unknown channel is refused', async (t) => {
  if (skip(t)) return;
  assert.equal((await post('poster', { text: 'Hi' })).status, 400);
  assert.equal((await post('poster', { channelId: 'x', text: 'Hi' })).status, 400);
  assert.ok([403, 404].includes((await post('poster', { channelId: 999999, text: 'Hi' })).status));
});
