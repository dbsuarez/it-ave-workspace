// Department forums: the topics REST API (list, create, rename, pin, lock, archive, delete).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config;
const ids = {};
const emitted = [];
const fakeIo = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'forum-topics-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const forums = require('../src/forums');
  const add = async (username, { type = 'member', superadmin = false } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [username, `${username}@x.test`, 'x', type, superadmin])).rows[0].id;
  ids.owner = await add('ft-owner', { superadmin: true });
  ids.head = await add('ft-head');
  ids.ann = await add('ft-ann');
  ids.bob = await add('ft-bob');
  ids.cara = await add('ft-cara');
  ids.mod = await add('ft-mod');
  ids.outsider = await add('ft-outsider');
  ids.guest = await add('ft-guest', { type: 'guest' });
  ids.mis = (await admin.query("INSERT INTO departments (name, head_id) VALUES ('MIS', $1) RETURNING id", [ids.head])).rows[0].id;
  ids.legal = (await admin.query("INSERT INTO departments (name) VALUES ('Legal') RETURNING id")).rows[0].id;
  for (const user of [ids.head, ids.ann, ids.bob, ids.mod]) await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [user, ids.mis]);
  await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids.cara, ids.legal]);
  const role = (await admin.query("INSERT INTO roles (name, permissions, position) VALUES ('ft-moderators', ARRAY['manage_messages'], 100) RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.mod, role]);
  const q = (...a) => admin.query(...a);
  ids.forum = await forums.ensureDepartmentForum(q, ids.mis);
  ids.legalForum = await forums.ensureDepartmentForum(q, ids.legal);
  ids.plain = (await admin.query("INSERT INTO channels (name) VALUES ('ft-plain') RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.plain, ids.ann]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = fakeIo; next(); });
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
async function call(userId, method, path, body) {
  const response = await fetch(`${baseUrl}/api/forums${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const create = (who, title, content = 'first post', extra = {}, channel = ids.forum) => call(who, 'POST', `/${channel}/topics`, { title, content, ...extra });
const topicRow = async (id) => (await admin.query('SELECT * FROM forum_topics WHERE id = $1', [id])).rows[0];
const auditActions = async (channel) => (await admin.query('SELECT action FROM moderation_audit_log WHERE channel_id = $1 ORDER BY id', [channel])).rows.map((r) => r.action);
const upload = async (userId, name) => (await admin.query(
  "INSERT INTO files (filename, original_name, size, mime_type, uploaded_by) VALUES ($1, $2, 10, 'text/plain', $3) RETURNING id", [`stored-${name}`, name, userId])).rows[0].id;

test('a department member starts a topic: trimmed title, an opening post with the topic id, and a live event', async (t) => {
  if (skip(t)) return;
  const before = emitted.length;
  const made = await create(ids.ann, '  Printer on floor 3  ', 'It jams every morning.');
  assert.equal(made.status, 201);
  assert.equal(made.json.topic.title, 'Printer on floor 3');
  assert.equal(made.json.topic.authorUsername, 'ft-ann');
  assert.equal(made.json.topic.replyCount, 0);
  const posts = (await admin.query('SELECT content, user_id, topic_id FROM messages WHERE topic_id = $1', [made.json.topic.id])).rows;
  assert.deepEqual(posts, [{ content: 'It jams every morning.', user_id: ids.ann, topic_id: made.json.topic.id }]);
  assert.ok(emitted.slice(before).some((e) => e.room === `channel_${ids.forum}` && e.event === 'forum_topic_created' && e.payload.topicId === made.json.topic.id));
});

test('bad titles and empty posts are refused and create nothing', async (t) => {
  if (skip(t)) return;
  const before = (await admin.query('SELECT COUNT(*)::int AS n FROM forum_topics')).rows[0].n;
  assert.equal((await create(ids.ann, '   ')).status, 400);
  assert.equal((await create(ids.ann, 'x'.repeat(121))).status, 400);
  assert.equal((await create(ids.ann, 'Fine title', '   ')).status, 400);
  assert.equal((await create(ids.ann, 'Fine title', 'y'.repeat(10001))).status, 400);
  assert.equal((await create(ids.ann, 123)).status, 400);
  assert.equal((await create(ids.ann, 'x'.repeat(120))).status, 201, 'exactly 120 is fine');
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM forum_topics')).rows[0].n, before + 1);
});

test('outsiders, other departments, guests, ordinary channels and archived forums cannot take part', async (t) => {
  if (skip(t)) return;
  assert.equal((await create(ids.outsider, 'nope')).status, 403);
  assert.equal((await create(ids.cara, 'nope')).status, 403, 'another department');
  assert.equal((await create(ids.guest, 'nope')).status, 403);
  assert.equal((await call(ids.cara, 'GET', `/${ids.forum}/topics`)).status, 403);
  assert.equal((await create(ids.ann, 'nope', 'x', {}, ids.plain)).status, 400, 'not a forum');
  assert.equal((await call(ids.ann, 'GET', `/${ids.plain}/topics`)).status, 400);
  const archived = (await admin.query("INSERT INTO channels (name, kind, is_private, archived_at) VALUES ('ft-archived', 'forum', TRUE, NOW()) RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [archived, ids.ann]);
  assert.equal((await create(ids.ann, 'nope', 'x', {}, archived)).status, 409);
});

test('attachments: the creator’s own uploads attach to the opening post; someone else’s upload refuses the whole request', async (t) => {
  if (skip(t)) return;
  const mine = await upload(ids.ann, 'floorplan.txt');
  const made = await create(ids.ann, 'With a file', 'see attached', { attachmentIds: [mine] });
  assert.equal(made.status, 201);
  const linked = (await admin.query('SELECT m.topic_id FROM files f JOIN messages m ON m.id = f.message_id WHERE f.id = $1', [mine])).rows[0];
  assert.equal(linked.topic_id, made.json.topic.id);
  const theirs = await upload(ids.bob, 'bobs.txt');
  const before = (await admin.query('SELECT COUNT(*)::int AS n FROM forum_topics')).rows[0].n;
  const refused = await create(ids.ann, 'Stolen file', 'x', { attachmentIds: [theirs] });
  assert.equal(refused.status, 400);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM forum_topics')).rows[0].n, before, 'no half-created topic');
  assert.equal((await admin.query('SELECT message_id FROM files WHERE id = $1', [theirs])).rows[0].message_id, null);
});

test('topics are listed pinned first, then by latest activity, archived ones separately, with paging', async (t) => {
  if (skip(t)) return;
  const forum = (await admin.query("INSERT INTO channels (name, kind, is_private) VALUES ('ft-list', 'forum', TRUE) RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [forum, ids.ann]);
  const topic = async (title, minutesAgo, extra = '') => (await admin.query(
    `INSERT INTO forum_topics (channel_id, title, created_by, last_activity_at ${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ($1, $2, $3, NOW() - ($4 || ' minutes')::interval ${extra ? ', NOW()' : ''}) RETURNING id`, [forum, title, ids.ann, String(minutesAgo)])).rows[0].id;
  await topic('old', 60); await topic('newest', 1); await topic('middle', 30);
  await topic('pinned but old', 500, 'pinned_at=1'); await topic('archived one', 5, 'archived_at=1');
  const titles = async (qs) => (await call(ids.ann, 'GET', `/${forum}/topics${qs}`)).json.topics.map((x) => x.title);
  assert.deepEqual(await titles(''), ['pinned but old', 'newest', 'middle', 'old']);
  assert.deepEqual(await titles('?archived=1'), ['archived one']);
  for (let i = 0; i < 52; i += 1) await topic(`bulk ${i}`, 600 + i);
  const page1 = (await call(ids.ann, 'GET', `/${forum}/topics`)).json;
  assert.equal(page1.topics.length, 50);
  assert.equal(page1.hasMore, true);
  assert.equal((await call(ids.ann, 'GET', `/${forum}/topics?offset=50`)).json.hasMore, false);
});

test('the author renames their own topic but cannot pin, lock or archive it', async (t) => {
  if (skip(t)) return;
  const id = (await create(ids.ann, 'Original')).json.topic.id;
  assert.equal((await call(ids.ann, 'PATCH', `/topics/${id}`, { title: 'Renamed' })).status, 200);
  assert.equal((await topicRow(id)).title, 'Renamed');
  for (const body of [{ pinned: true }, { locked: true }, { archived: true }]) assert.equal((await call(ids.ann, 'PATCH', `/topics/${id}`, body)).status, 403, JSON.stringify(body));
  assert.equal((await call(ids.bob, 'PATCH', `/topics/${id}`, { title: 'Hijack' })).status, 403, 'another member cannot rename it');
  assert.equal((await call(ids.ann, 'PATCH', `/topics/${id}`, { title: '' })).status, 400);
  assert.equal((await call(ids.ann, 'PATCH', `/topics/${id}`, {})).status, 400, 'nothing to change');
  assert.equal((await call(ids.ann, 'PATCH', `/topics/${id}`, { pinned: 'yes' })).status, 400);
});

test('the department head and a manage_messages holder pin, lock, archive and rename; each change is audited', async (t) => {
  if (skip(t)) return;
  const id = (await create(ids.ann, 'Moderated')).json.topic.id;
  const before = (await auditActions(ids.forum)).length;
  assert.equal((await call(ids.head, 'PATCH', `/topics/${id}`, { pinned: true })).status, 200);
  assert.ok((await topicRow(id)).pinned_at);
  assert.equal((await call(ids.mod, 'PATCH', `/topics/${id}`, { locked: true, title: 'Moderated (locked)' })).status, 200);
  const locked = await topicRow(id);
  assert.ok(locked.locked_at);
  assert.equal(locked.title, 'Moderated (locked)');
  assert.equal((await call(ids.head, 'PATCH', `/topics/${id}`, { archived: true })).status, 200);
  assert.ok((await topicRow(id)).archived_at);
  assert.equal((await call(ids.head, 'PATCH', `/topics/${id}`, { pinned: false, locked: false, archived: false })).status, 200);
  const clear = await topicRow(id);
  assert.deepEqual([clear.pinned_at, clear.locked_at, clear.archived_at], [null, null, null]);
  const actions = (await auditActions(ids.forum)).slice(before);
  for (const action of ['forum_topic_pinned', 'forum_topic_locked', 'forum_topic_archived', 'forum_topic_renamed', 'forum_topic_unpinned', 'forum_topic_unlocked', 'forum_topic_unarchived']) {
    assert.ok(actions.includes(action), `${action} is audited`);
  }
  assert.equal((await call(ids.outsider, 'PATCH', `/topics/${id}`, { pinned: true })).status, 403);
});

test('a locked or archived topic cannot be renamed by its author', async (t) => {
  if (skip(t)) return;
  const id = (await create(ids.ann, 'Frozen')).json.topic.id;
  await call(ids.head, 'PATCH', `/topics/${id}`, { locked: true });
  assert.equal((await call(ids.ann, 'PATCH', `/topics/${id}`, { title: 'Thawed' })).status, 409);
  await call(ids.head, 'PATCH', `/topics/${id}`, { locked: false, archived: true });
  assert.equal((await call(ids.ann, 'PATCH', `/topics/${id}`, { title: 'Thawed' })).status, 409);
  assert.equal((await topicRow(id)).title, 'Frozen');
});

test('deleting: the author only while there are no replies, moderators always, outsiders never; posts and the audit trail follow', async (t) => {
  if (skip(t)) return;
  const quiet = (await create(ids.ann, 'Quiet topic')).json.topic.id;
  assert.equal((await call(ids.bob, 'DELETE', `/topics/${quiet}`)).status, 403, 'another member');
  assert.equal((await call(ids.outsider, 'DELETE', `/topics/${quiet}`)).status, 403);
  assert.equal((await call(ids.ann, 'DELETE', `/topics/${quiet}`)).status, 200, 'the author, no replies yet');
  assert.equal(await topicRow(quiet), undefined);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM messages WHERE topic_id = $1', [quiet])).rows[0].n, 0, 'its posts went with it');

  const busy = (await create(ids.ann, 'Busy topic')).json.topic.id;
  await admin.query("INSERT INTO messages (channel_id, user_id, content, topic_id) VALUES ($1, $2, 'a reply', $3)", [ids.forum, ids.bob, busy]);
  assert.equal((await call(ids.ann, 'DELETE', `/topics/${busy}`)).status, 409, 'the author once it has replies');
  assert.equal((await call(ids.head, 'DELETE', `/topics/${busy}`)).status, 200, 'a moderator');
  assert.ok((await auditActions(ids.forum)).includes('forum_topic_deleted'));
  assert.equal((await call(ids.head, 'DELETE', `/topics/${busy}`)).status, 404);
});

test('a topic of another department’s forum cannot be changed from outside it', async (t) => {
  if (skip(t)) return;
  const id = (await create(ids.cara, 'Legal only', 'x', {}, ids.legalForum)).json.topic.id;
  assert.equal((await call(ids.ann, 'PATCH', `/topics/${id}`, { title: 'x' })).status, 403);
  assert.equal((await call(ids.head, 'DELETE', `/topics/${id}`)).status, 403, 'the MIS head has no say in Legal');
  assert.equal((await call(ids.ann, 'PATCH', '/topics/999999', { title: 'x' })).status, 404);
});
