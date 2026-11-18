// Department forums: posting into a topic over the socket and reading a topic's history. Real PostgreSQL, fake sockets.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config; let registerChatHandlers;
const ids = {};
const emitted = [];
const rooms = new Map();
const io = {
  sockets: { sockets: new Map() },
  to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
  in: () => ({ fetchSockets: async () => [] }),
};

class FakeSocket {
  constructor(id) { this.id = id; this.data = {}; this.handlers = new Map(); this.sent = []; }
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, data) { this.sent.push({ event, data }); }
  join(room) { rooms.set(room, true); }
  leave() {}
  to() { return { emit() {} }; }
  disconnect() {}
  take(event) { const i = this.sent.findIndex((e) => e.event === event); return i < 0 ? null : this.sent.splice(i, 1)[0].data; }
}

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'forum-posts-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  registerChatHandlers = require('../src/sockets/chat');
  const forums = require('../src/forums');
  const add = async (username, type = 'member') => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, $3, $4) RETURNING id',
    [username, `${username}@x.test`, 'x', type])).rows[0].id;
  ids.ann = await add('fp-ann');
  ids.bob = await add('fp-bob');
  ids.cara = await add('fp-cara');
  ids.guest = await add('fp-guest', 'guest');
  ids.mis = (await admin.query("INSERT INTO departments (name) VALUES ('MIS') RETURNING id")).rows[0].id;
  ids.legal = (await admin.query("INSERT INTO departments (name) VALUES ('Legal') RETURNING id")).rows[0].id;
  for (const user of [ids.ann, ids.bob]) await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [user, ids.mis]);
  await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids.cara, ids.legal]);
  const q = (...a) => admin.query(...a);
  ids.forum = await forums.ensureDepartmentForum(q, ids.mis);
  ids.legalForum = await forums.ensureDepartmentForum(q, ids.legal);
  ids.plain = (await admin.query("INSERT INTO channels (name) VALUES ('fp-plain') RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)', [ids.plain, ids.ann, ids.bob]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = io; next(); });
  app.use('/api/messages', require('../src/routes/messages'));
  app.use('/api/messages', require('../src/routes/messageEdits'));
  app.use('/api/forums', require('../src/routes/forums'));
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
const token = (userId) => jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET);
async function connect(userId) {
  const socket = new FakeSocket(`s${userId}-${Math.random()}`);
  registerChatHandlers(io, socket);
  await socket.handlers.get('authenticate')(token(userId));
  return socket;
}
// sends a message and resolves with { sent, error } once the handler has finished
async function send(userId, payload) {
  const socket = await connect(userId);
  await socket.handlers.get('send_message')({ clientMessageId: 'c1', ...payload });
  return { sent: socket.take('message_sent'), error: socket.take('message_error') };
}
async function http_(userId, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${token(userId)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const newTopic = async (title = 'T', channel = ids.forum, user = ids.ann) => (await http_(user, 'POST', `/api/forums/${channel}/topics`, { title, content: 'opening post' })).json.topic.id;
const topic = async (id) => (await admin.query('SELECT * FROM forum_topics WHERE id = $1', [id])).rows[0];

test('a forum post needs a topic; a valid open topic takes it, raises activity and reply count, and the event carries topicId', async (t) => {
  if (skip(t)) return;
  const id = await newTopic('Posting');
  const before = (await topic(id)).last_activity_at;
  assert.match((await send(ids.bob, { channelId: ids.forum, content: 'no topic' })).error.error, /topic/i);
  await new Promise((r) => setTimeout(r, 15));
  const before_events = emitted.length;
  const posted = await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'a reply' });
  assert.ok(posted.sent, JSON.stringify(posted.error));
  assert.equal(posted.sent.message.topicId, id);
  assert.equal((await admin.query('SELECT topic_id FROM messages WHERE id = $1', [posted.sent.messageId])).rows[0].topic_id, id);
  assert.ok((await topic(id)).last_activity_at > before, 'activity time moved');
  assert.equal((await http_(ids.bob, 'GET', `/api/forums/${ids.forum}/topics`)).json.topics.find((x) => x.id === id).replyCount, 1);
  assert.ok(emitted.slice(before_events).some((e) => e.event === 'new_message' && e.payload.topicId === id));
});

test('a topic of another channel, a missing topic, and a topic in an ordinary channel are refused', async (t) => {
  if (skip(t)) return;
  const legalTopic = await newTopic('Legal', ids.legalForum, ids.cara);
  const mine = await newTopic('Mine');
  assert.ok((await send(ids.bob, { channelId: ids.forum, topicId: legalTopic, content: 'x' })).error, 'other forum’s topic');
  assert.ok((await send(ids.bob, { channelId: ids.forum, topicId: 999999, content: 'x' })).error, 'no such topic');
  assert.ok((await send(ids.bob, { channelId: ids.forum, topicId: 'abc', content: 'x' })).error, 'not an id');
  assert.ok((await send(ids.bob, { channelId: ids.plain, topicId: mine, content: 'x' })).error, 'topic in an ordinary channel');
  assert.ok((await send(ids.bob, { channelId: ids.plain, content: 'ordinary still works' })).sent);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM messages WHERE content = 'x'")).rows[0].n, 0);
});

test('locked and archived topics and an archived forum refuse posts; unlocking restores them', async (t) => {
  if (skip(t)) return;
  const id = await newTopic('Frozen');
  await admin.query('UPDATE forum_topics SET locked_at = NOW() WHERE id = $1', [id]);
  assert.match((await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'x' })).error.error, /locked|closed|read-only/i);
  await admin.query('UPDATE forum_topics SET locked_at = NULL, archived_at = NOW() WHERE id = $1', [id]);
  assert.ok((await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'x' })).error);
  await admin.query('UPDATE forum_topics SET archived_at = NULL WHERE id = $1', [id]);
  assert.ok((await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'works again' })).sent);
  const dead = (await admin.query("INSERT INTO channels (name, kind, is_private, archived_at) VALUES ('fp-dead', 'forum', TRUE, NOW()) RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [dead, ids.bob]);
  const deadTopic = (await admin.query("INSERT INTO forum_topics (channel_id, title, created_by) VALUES ($1, 'old', $2) RETURNING id", [dead, ids.bob])).rows[0].id;
  assert.match((await send(ids.bob, { channelId: dead, topicId: deadTopic, content: 'x' })).error.error, /archived/i);
});

test('banned, timed-out, moved-out and guest users cannot post', async (t) => {
  if (skip(t)) return;
  const id = await newTopic('Gate');
  await admin.query("INSERT INTO channel_bans (channel_id, user_id, reason) VALUES ($1, $2, 'test')", [ids.forum, ids.bob]);
  assert.ok((await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'x' })).error, 'banned');
  await admin.query('DELETE FROM channel_bans WHERE channel_id = $1 AND user_id = $2', [ids.forum, ids.bob]);
  await admin.query("INSERT INTO channel_timeouts (channel_id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')", [ids.forum, ids.bob]);
  assert.match((await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'x' })).error.error, /timed out/i);
  await admin.query('DELETE FROM channel_timeouts WHERE channel_id = $1', [ids.forum]);
  assert.ok((await send(ids.cara, { channelId: ids.forum, topicId: id, content: 'x' })).error, 'another department');
  assert.ok((await send(ids.guest, { channelId: ids.forum, topicId: id, content: 'x' })).error, 'guest');
  await admin.query('DELETE FROM user_departments WHERE user_id = $1 AND department_id = $2', [ids.bob, ids.mis]);
  assert.ok((await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'x' })).error, 'moved out');
  await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids.bob, ids.mis]);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM messages WHERE content = 'x'")).rows[0].n, 0);
});

test('a reply racing a lock never ends up newer than the lock', async (t) => {
  if (skip(t)) return;
  await admin.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'moderator') ON CONFLICT (channel_id, user_id) DO UPDATE SET role = 'moderator'", [ids.forum, ids.ann]);
  for (let round = 0; round < 12; round += 1) {
    const id = await newTopic(`Race ${round}`);
    await Promise.all([
      send(ids.bob, { channelId: ids.forum, topicId: id, content: `race ${round}` }),
      http_(ids.ann, 'PATCH', `/api/forums/topics/${id}`, { locked: true }),
    ]);
    const row = await topic(id);
    assert.ok(row.locked_at, 'locked');
    const late = (await admin.query('SELECT COUNT(*)::int AS n FROM messages WHERE topic_id = $1 AND created_at > $2', [id, row.locked_at])).rows[0].n;
    assert.equal(late, 0, `round ${round}: a post landed after the lock`);
  }
});

test('a post that was waiting on an uncommitted lock is refused once the lock commits (deterministic)', async (t) => {
  if (skip(t)) return;
  const forums = require('../src/forums');
  const id = await newTopic('Held');
  const holder = await scratch.open();
  try {
    await holder.query('BEGIN');
    await holder.query('UPDATE forum_topics SET locked_at = NOW() WHERE id = $1', [id]);
    let settled = false;
    const attempt = forums.insertTopicMessage(pool, { channelId: ids.forum, topicId: id, userId: ids.bob, content: 'too late', attachmentIds: [] })
      .then((m) => ({ m }), (error) => ({ error })).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, 'the post waits for the topic row');
    await holder.query('COMMIT');
    const outcome = await attempt;
    assert.equal(outcome.error && outcome.error.status, 409);
    assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM messages WHERE content = 'too late'")).rows[0].n, 0);
  } finally {
    await holder.end();
  }
});

test('history: a forum needs a topic, a topic returns only its posts in order, another channel’s topic is 404, ordinary history never holds topic posts', async (t) => {
  if (skip(t)) return;
  const a = await newTopic('Hist A');
  const b = await newTopic('Hist B');
  await send(ids.bob, { channelId: ids.forum, topicId: a, content: 'a2' });
  await send(ids.ann, { channelId: ids.forum, topicId: a, content: 'a3' });
  await send(ids.bob, { channelId: ids.forum, topicId: b, content: 'b2' });
  const none = await http_(ids.ann, 'GET', `/api/messages/${ids.forum}`);
  assert.equal(none.status, 400);
  assert.match(none.json.error, /topic/i);
  const history = await http_(ids.ann, 'GET', `/api/messages/${ids.forum}?topicId=${a}`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.json.messages.map((m) => m.content), ['opening post', 'a2', 'a3']);
  assert.ok(history.json.messages.every((m) => m.topicId === a));
  const legalTopic = await newTopic('Elsewhere', ids.legalForum, ids.cara);
  assert.equal((await http_(ids.ann, 'GET', `/api/messages/${ids.forum}?topicId=${legalTopic}`)).status, 404);
  assert.equal((await http_(ids.ann, 'GET', `/api/messages/${ids.forum}?topicId=abc`)).status, 400);
  assert.equal((await http_(ids.cara, 'GET', `/api/messages/${ids.forum}?topicId=${a}`)).status, 403);
  await send(ids.ann, { channelId: ids.plain, content: 'ordinary message' });
  assert.equal((await http_(ids.ann, 'GET', `/api/messages/${ids.plain}?topicId=${a}`)).status, 400, 'topics only exist in forums');
  const plain = await http_(ids.ann, 'GET', `/api/messages/${ids.plain}`);
  assert.equal(plain.status, 200);
  assert.ok(plain.json.messages.some((m) => m.content === 'ordinary message'));
  assert.ok(plain.json.messages.every((m) => !m.topicId));
});

test('a reply-to inside a topic must point at a post of the same topic', async (t) => {
  if (skip(t)) return;
  const a = await newTopic('Reply A');
  const b = await newTopic('Reply B');
  const inB = (await admin.query('SELECT id FROM messages WHERE topic_id = $1', [b])).rows[0].id;
  const inA = (await admin.query('SELECT id FROM messages WHERE topic_id = $1', [a])).rows[0].id;
  assert.ok((await send(ids.bob, { channelId: ids.forum, topicId: a, content: 'cross', replyTo: inB })).error, 'cross-topic reply refused');
  const ok = await send(ids.bob, { channelId: ids.forum, topicId: a, content: 'in-topic', replyTo: inA });
  assert.ok(ok.sent);
  assert.equal(ok.sent.message.replyTo, inA);
});

test('nothing else can drop a topic-less post into a forum: announcements, scheduled messages, webhooks and polls are refused', async (t) => {
  if (skip(t)) return;
  const { postChannelMessage } = require('../src/messageDelivery');
  const polls = require('../src/polls');
  const q = (...a) => admin.query(...a);
  await assert.rejects(() => postChannelMessage(io, q, { userId: ids.ann, channelId: ids.forum, content: 'announce' }), (e) => e.status === 400 && /topic/i.test(e.message));
  await assert.rejects(() => polls.createPoll(io, q, { userId: ids.ann, channelId: ids.forum, question: 'Lunch?', options: ['a', 'b'] }), (e) => e.status === 400 && /topic/i.test(e.message));
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = $1 AND topic_id IS NULL', [ids.forum])).rows[0].n, 0, 'the forum holds no topic-less posts');
  const ok = await postChannelMessage(io, q, { userId: ids.ann, channelId: ids.plain, content: 'ordinary announce' });
  assert.ok(ok.id, 'ordinary channels are unaffected');
});

test('a thread reply to a topic post belongs to that topic and obeys its lock', async (t) => {
  if (skip(t)) return;
  const id = await newTopic('Threaded');
  const first = (await admin.query('SELECT id FROM messages WHERE topic_id = $1', [id])).rows[0].id;
  const reply = await http_(ids.bob, 'POST', `/api/messages/${first}/replies`, { content: 'a thread reply' });
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  assert.equal((await admin.query('SELECT topic_id FROM messages WHERE id = $1', [reply.json.reply.id])).rows[0].topic_id, id);
  assert.equal((await http_(ids.ann, 'GET', `/api/forums/${ids.forum}/topics`)).json.topics.find((x) => x.id === id).replyCount, 1);
  await admin.query('UPDATE forum_topics SET locked_at = NOW() WHERE id = $1', [id]);
  assert.equal((await http_(ids.bob, 'POST', `/api/messages/${first}/replies`, { content: 'too late' })).status, 409);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM messages WHERE content = 'too late'")).rows[0].n, 0);
});

test('an author cannot edit or delete a post in a locked or archived topic; a moderator still can remove one', async (t) => {
  if (skip(t)) return;
  const id = await newTopic('Frozen edits');
  const posted = await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'my reply' });
  const mine = posted.sent.messageId;
  assert.equal((await http_(ids.bob, 'PATCH', `/api/messages/${mine}`, { content: 'edited while open' })).status, 200);
  await admin.query('UPDATE forum_topics SET locked_at = NOW() WHERE id = $1', [id]);
  assert.equal((await http_(ids.bob, 'PATCH', `/api/messages/${mine}`, { content: 'edited when locked' })).status, 409);
  assert.equal((await http_(ids.bob, 'DELETE', `/api/messages/${mine}`)).status, 409);
  await admin.query('UPDATE forum_topics SET locked_at = NULL, archived_at = NOW() WHERE id = $1', [id]);
  assert.equal((await http_(ids.bob, 'DELETE', `/api/messages/${mine}`)).status, 409, 'archived too');
  assert.equal((await admin.query('SELECT content FROM messages WHERE id = $1', [mine])).rows[0].content, 'edited while open');
  await admin.query('UPDATE forum_topics SET archived_at = NULL WHERE id = $1', [id]);
  assert.equal((await http_(ids.bob, 'DELETE', `/api/messages/${mine}`)).status, 200, 'open again: allowed');
});

test('the reply count stays right when the opening post is deleted', async (t) => {
  if (skip(t)) return;
  const id = await newTopic('Count me');
  await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'r1' });
  await send(ids.bob, { channelId: ids.forum, topicId: id, content: 'r2' });
  const count = async () => (await http_(ids.bob, 'GET', `/api/forums/topics/${id}`)).json.topic.replyCount;
  assert.equal(await count(), 2);
  await admin.query('DELETE FROM messages WHERE topic_id = $1 AND content = $2', [id, 'opening post']);
  assert.equal(await count(), 2, 'still two replies');
});

test('the pinned list of a topic holds only that topic’s pins', async (t) => {
  if (skip(t)) return;
  const a = await newTopic('Pins A');
  const b = await newTopic('Pins B');
  const first = async (topic) => (await admin.query('SELECT id FROM messages WHERE topic_id = $1 ORDER BY id LIMIT 1', [topic])).rows[0].id;
  await admin.query('UPDATE messages SET pinned_at = NOW() WHERE id = ANY($1)', [[await first(a), await first(b)]]);
  const pinsOf = async (qs) => (await http_(ids.ann, 'GET', `/api/messages/${ids.forum}/pins${qs}`)).json.messages.map((m) => m.id);
  assert.deepEqual(await pinsOf(`?topicId=${a}`), [await first(a)]);
  assert.equal((await pinsOf('')).length >= 1, true);
});
