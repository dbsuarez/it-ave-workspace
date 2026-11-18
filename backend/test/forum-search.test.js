// Department forums: search, the Files list and Activity know about topics, and keep the forum's privacy. Real PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config; let forums; let notifyMessageActivity;
const ids = {};
const emitted = [];
const fakeIo = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }), in: () => ({ fetchSockets: async () => [] }) };

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'forum-search-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  forums = require('../src/forums');
  notifyMessageActivity = require('../src/sockets/chat').notifyMessageActivity;
  const add = async (username, superadmin = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id',
    [username, `${username}@x.test`, 'x', superadmin])).rows[0].id;
  ids.owner = await add('fs-owner', true);
  ids.ann = await add('fs-ann');
  ids.bob = await add('fs-bob');
  ids.cara = await add('fs-cara');
  ids.moved = await add('fs-moved');
  ids.mis = (await admin.query("INSERT INTO departments (name) VALUES ('MIS') RETURNING id")).rows[0].id;
  ids.legal = (await admin.query("INSERT INTO departments (name) VALUES ('Legal') RETURNING id")).rows[0].id;
  for (const user of [ids.ann, ids.bob, ids.moved]) await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [user, ids.mis]);
  await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids.cara, ids.legal]);
  ids.forum = await forums.ensureDepartmentForum((...a) => admin.query(...a), ids.mis);
  ids.plain = (await admin.query("INSERT INTO channels (name) VALUES ('fs-plain') RETURNING id")).rows[0].id;
  for (const user of [ids.ann, ids.cara, ids.moved]) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.plain, user]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = fakeIo; next(); });
  for (const [path, file] of [['/api/forums', 'forums'], ['/api/search', 'search'], ['/api/files', 'files'], ['/api/activity', 'activity'], ['/api/commands', 'commands']]) app.use(path, require(`../src/routes/${file}`));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // one topic with a post and an attachment, and one ordinary message and file with the same word
  const file = (user, name) => admin.query("INSERT INTO files (filename, original_name, size, mime_type, uploaded_by) VALUES ($1, $2, 10, 'text/plain', $3) RETURNING id", [`stored-${name}`, name, user]).then((r) => r.rows[0].id);
  const attached = await file(ids.ann, 'zebra-plan.txt');
  const made = await call(ids.ann, 'POST', `/api/forums/${ids.forum}/topics`, { title: 'Quarterly zebra budget', content: 'opening words', attachmentIds: [attached] });
  ids.topic = made.json.topic.id;
  await forums.insertTopicMessage(pool, { channelId: ids.forum, topicId: ids.topic, userId: ids.bob, content: 'the zebra stapler is broken', attachmentIds: [] });
  const ordinary = (await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'zebra in an ordinary channel') RETURNING id", [ids.plain, ids.ann])).rows[0].id;
  const ordinaryFile = await file(ids.ann, 'zebra-ordinary.txt');
  await admin.query('UPDATE files SET message_id = $1 WHERE id = $2', [ordinary, ordinaryFile]);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
async function call(userId, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const search = (user, term) => call(user, 'GET', `/api/search?q=${encodeURIComponent(term)}`);
const found = (r) => r.json.messages.length + r.json.files.length + (r.json.topics || []).length;

test('a member finds the topic by title, a post by its text and an attachment by file name, each labelled with the topic', async (t) => {
  if (skip(t)) return;
  const topicHit = await search(ids.bob, 'Quarterly zebra');
  assert.deepEqual(topicHit.json.topics, [{ id: ids.topic, channelId: ids.forum, channelName: 'dept-mis', title: 'Quarterly zebra budget' }]);
  const zebra = await search(ids.bob, 'zebra');
  const post = zebra.json.messages.find((m) => m.content === 'the zebra stapler is broken');
  assert.equal(post.topicId, ids.topic);
  assert.equal(post.topicTitle, 'Quarterly zebra budget');
  const attachment = zebra.json.files.find((f) => f.name === 'zebra-plan.txt');
  assert.equal(attachment.topicId, ids.topic);
  assert.equal(attachment.topicTitle, 'Quarterly zebra budget');
});

test('an ordinary channel result is unchanged: no topic', async (t) => {
  if (skip(t)) return;
  const zebra = await search(ids.ann, 'zebra');
  const message = zebra.json.messages.find((m) => m.content === 'zebra in an ordinary channel');
  assert.equal(message.topicId, null);
  assert.equal(message.topicTitle, null);
  const file = zebra.json.files.find((f) => f.name === 'zebra-ordinary.txt');
  assert.equal(file.topicId, null);
  assert.equal(file.topicTitle, null);
});

test('GET /api/files labels a topic attachment, and shows it to department members only', async (t) => {
  if (skip(t)) return;
  const mine = (await call(ids.bob, 'GET', '/api/files')).json.files.find((f) => f.name === 'zebra-plan.txt');
  assert.equal(mine.topicTitle, 'Quarterly zebra budget');
  assert.equal(mine.topicId, ids.topic);
  const ordinary = (await call(ids.ann, 'GET', '/api/files')).json.files.find((f) => f.name === 'zebra-ordinary.txt');
  assert.equal(ordinary.topicTitle, null);
  for (const [who, label] of [[ids.cara, 'another department'], [ids.owner, 'an Owner with the switch off']]) {
    assert.ok(!(await call(who, 'GET', '/api/files')).json.files.some((f) => f.name === 'zebra-plan.txt'), label);
  }
});

test('people outside the department, an Owner with the switch off, and someone moved out find none of it', async (t) => {
  if (skip(t)) return;
  for (const [who, label] of [[ids.cara, 'another department'], [ids.owner, 'an Owner who is not a member']]) {
    const r = await search(who, 'zebra');
    assert.ok(!r.json.messages.some((m) => m.channelId === ids.forum), `${label}: no forum posts`);
    assert.ok(!r.json.files.some((f) => f.channelId === ids.forum), `${label}: no forum files`);
    assert.deepEqual(r.json.topics, [], `${label}: no topics`);
  }
  await admin.query('DELETE FROM user_departments WHERE user_id = $1 AND department_id = $2', [ids.moved, ids.mis]);
  const moved = await search(ids.moved, 'zebra');
  assert.deepEqual(moved.json.topics, [], 'moved out: no topics');
  assert.ok(!moved.json.messages.some((m) => m.channelId === ids.forum), 'moved out: no posts');
  assert.ok(moved.json.messages.some((m) => m.channelId === ids.plain), 'still sees what they are allowed to');
  await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids.moved, ids.mis]);
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = TRUE WHERE id = 1');
  const owner = await search(ids.owner, 'zebra');
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = FALSE WHERE id = 1');
  assert.equal(owner.json.topics.length, 1, 'the Owner switch opens it');
});

test('the /search command shows the same, and nothing more', async (t) => {
  if (skip(t)) return;
  const run = (who, term) => call(who, 'POST', '/api/commands/execute', { channelId: ids.plain, command: `/search ${term}`, requestId: `s${Math.random()}` });
  const member = await run(ids.ann, 'zebra');
  assert.equal(member.status, 200, JSON.stringify(member.json));
  const text = JSON.stringify(member.json);
  assert.match(text, /Quarterly zebra budget/);
  const outsider = await run(ids.cara, 'zebra');
  assert.equal(outsider.status, 200, JSON.stringify(outsider.json));
  assert.doesNotMatch(JSON.stringify(outsider.json), /Quarterly zebra budget|zebra stapler|zebra-plan/);
});

test('a mention in a topic reaches Activity with the topic title, and only for people who may still see the forum', async (t) => {
  if (skip(t)) return;
  const before = emitted.length;
  const content = 'please look @fs-bob';
  const message = await forums.insertTopicMessage(pool, { channelId: ids.forum, topicId: ids.topic, userId: ids.ann, content, attachmentIds: [] });
  await notifyMessageActivity(fakeIo, (...a) => admin.query(...a), {
    id: message.id, channelId: ids.forum, userId: ids.ann, username: 'fs-ann', avatarColor: '#000', content, topicId: ids.topic, createdAt: message.created_at,
  }, null);
  const live = emitted.slice(before).find((e) => e.event === 'activity' && e.room === `user_${ids.bob}`);
  assert.equal(live.payload.topicId, ids.topic);
  assert.equal(live.payload.topicTitle, 'Quarterly zebra budget');
  const feed = (await call(ids.bob, 'GET', '/api/activity')).json.items.find((i) => i.messageId === message.id);
  assert.equal(feed.type, 'mention');
  assert.equal(feed.topicId, ids.topic);
  assert.equal(feed.topicTitle, 'Quarterly zebra budget');
  await admin.query('DELETE FROM user_departments WHERE user_id = $1 AND department_id = $2', [ids.bob, ids.mis]);
  assert.ok(!(await call(ids.bob, 'GET', '/api/activity')).json.items.some((i) => i.messageId === message.id), 'moved out: the item disappears');
  await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids.bob, ids.mis]);
});
