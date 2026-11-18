// Department forums: schema, naming, and automatic creation of one forum per department.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let forums;
const ids = {};
const q = (...args) => admin.query(...args);

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  forums = require('../src/forums');
  ids.head = (await q("INSERT INTO users (username, email, password_hash) VALUES ('fs-head', 'fs-head@x.test', 'x') RETURNING id")).rows[0].id;
  ids.mis = (await q("INSERT INTO departments (name, head_id) VALUES ('MIS', $1) RETURNING id", [ids.head])).rows[0].id;
  ids.hr = (await q("INSERT INTO departments (name) VALUES ('Human Resource') RETURNING id")).rows[0].id;
});

test.after(async () => {
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

test('the forum columns and tables exist, and running the migrations again changes nothing', async (t) => {
  if (skip(t)) return;
  const cols = async (table) => (await q('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])).rows.map((r) => r.column_name);
  assert.ok((await cols('channels')).includes('kind') && (await cols('channels')).includes('forum_department_id'));
  assert.ok((await cols('messages')).includes('topic_id'));
  assert.deepEqual((await cols('forum_topics')).sort(), ['archived_at', 'channel_id', 'created_at', 'created_by', 'id', 'last_activity_at', 'locked_at', 'pinned_at', 'title']);
  await scratch.applyMigrations(admin);
  await scratch.applyMigrations(admin);
  assert.equal((await q("SELECT COUNT(*)::int AS n FROM channels WHERE kind <> 'channel'")).rows[0].n, 0, 'migrations alone create no forums');
});

test('forum channel names follow the channel-name format and stay within 50 characters', () => {
  assert.equal(forums.forumChannelName('Human Resource', 6), 'dept-human-resource');
  assert.equal(forums.forumChannelName('Fabrication/Engineering Unit', 29), 'dept-fabrication-engineering-unit');
  const long = forums.forumChannelName('A very long department name that keeps on going and going forever', 3);
  assert.ok(long.length <= 50 && /^[a-z0-9-]+$/.test(long) && !long.endsWith('-'), long);
  assert.equal(forums.forumChannelName('***', 6), 'dept-6');
});

test('a department gets one private forum with its department grant and its head as moderator', async (t) => {
  if (skip(t)) return;
  const channelId = await forums.ensureDepartmentForum(q, ids.mis);
  const channel = (await q('SELECT name, kind, is_private, is_personal, slowmode_seconds, forum_department_id, archived_at FROM channels WHERE id = $1', [channelId])).rows[0];
  assert.deepEqual(channel, { name: 'dept-mis', kind: 'forum', is_private: true, is_personal: false, slowmode_seconds: 0, forum_department_id: ids.mis, archived_at: null });
  assert.equal((await q('SELECT COUNT(*)::int AS n FROM channel_department_grants WHERE channel_id = $1 AND department_id = $2', [channelId, ids.mis])).rows[0].n, 1);
  const head = (await q('SELECT role, membership_source FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channelId, ids.head])).rows;
  assert.deepEqual(head, [{ role: 'moderator', membership_source: 'dept-head' }]);
});

test('creating a forum again is a no-op that returns the same channel', async (t) => {
  if (skip(t)) return;
  const first = await forums.ensureDepartmentForum(q, ids.mis);
  const second = await forums.ensureDepartmentForum(q, ids.mis);
  assert.equal(first, second);
  assert.equal((await q('SELECT COUNT(*)::int AS n FROM channels WHERE forum_department_id = $1', [ids.mis])).rows[0].n, 1);
  assert.equal((await q('SELECT COUNT(*)::int AS n FROM channel_members WHERE channel_id = $1', [first])).rows[0].n, 1);
});

test('a name clash with an existing channel gets the department id appended', async (t) => {
  if (skip(t)) return;
  await q("INSERT INTO channels (name) VALUES ('dept-human-resource')");
  const channelId = await forums.ensureDepartmentForum(q, ids.hr);
  assert.equal((await q('SELECT name FROM channels WHERE id = $1', [channelId])).rows[0].name, `dept-human-resource-${ids.hr}`);
  assert.equal((await q('SELECT COUNT(*)::int AS n FROM channel_members WHERE channel_id = $1', [channelId])).rows[0].n, 0, 'no head, no moderator row');
});

test('ensureAllForums creates a forum for every department that lacks one, and none the second time', async (t) => {
  if (skip(t)) return;
  const extra = (await q("INSERT INTO departments (name) VALUES ('Legal') RETURNING id")).rows[0].id;
  assert.equal(await forums.ensureAllForums(q), 1);
  assert.equal(await forums.ensureAllForums(q), 0);
  assert.equal((await q('SELECT COUNT(*)::int AS n FROM channels WHERE forum_department_id = $1', [extra])).rows[0].n, 1);
  await assert.rejects(() => forums.ensureDepartmentForum(q, 999999), /not found/i);
});

test('deleting a topic deletes its posts', async (t) => {
  if (skip(t)) return;
  const channelId = await forums.ensureDepartmentForum(q, ids.mis);
  const topic = (await q("INSERT INTO forum_topics (channel_id, title, created_by) VALUES ($1, 'T', $2) RETURNING id", [channelId, ids.head])).rows[0].id;
  await q("INSERT INTO messages (channel_id, user_id, content, topic_id) VALUES ($1, $2, 'opening', $3), ($1, $2, 'reply', $3)", [channelId, ids.head, topic]);
  await q('DELETE FROM forum_topics WHERE id = $1', [topic]);
  assert.equal((await q('SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = $1', [channelId])).rows[0].n, 0);
});
