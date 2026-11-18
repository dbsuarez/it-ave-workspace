// Department forums: who can open them, and how department changes (create, rename, head, move, delete) keep them in step.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config; let forums;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'forum-lifecycle-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  forums = require('../src/forums');
  const add = async (username, { type = 'member', superadmin = false } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [username, `${username}@x.test`, 'x', type, superadmin])).rows[0].id;
  ids.owner = await add('fl-owner', { superadmin: true });
  ids.ann = await add('fl-ann');
  ids.bob = await add('fl-bob');
  ids.cara = await add('fl-cara');
  ids.nodept = await add('fl-nodept');
  ids.guest = await add('fl-guest', { type: 'guest' });
  ids.mis = (await admin.query("INSERT INTO departments (name, head_id) VALUES ('MIS', $1) RETURNING id", [ids.ann])).rows[0].id;
  ids.legal = (await admin.query("INSERT INTO departments (name) VALUES ('Legal') RETURNING id")).rows[0].id;
  const join = (user, dept) => admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [user, dept]);
  await join(ids.ann, ids.mis); await join(ids.bob, ids.mis); await join(ids.cara, ids.legal);
  ids.misForum = await forums.ensureDepartmentForum((...a) => admin.query(...a), ids.mis);
  const app = express();
  app.use(express.json());
  app.use('/api/channels', require('../src/routes/channels'));
  app.use('/api/hr', require('../src/routes/hr'));
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
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const open = async (who, channelId) => (await call(who, 'GET', `/api/channels/${channelId}`)).status;
const forumOf = async (deptId) => (await admin.query('SELECT id, name, archived_at, forum_department_id FROM channels WHERE forum_department_id = $1', [deptId])).rows[0];
const mods = async (channelId) => (await admin.query("SELECT user_id FROM channel_members WHERE channel_id = $1 AND role = 'moderator' ORDER BY user_id", [channelId])).rows.map((r) => r.user_id);

test('only people in the department can open its forum; the head can too; everyone else is refused', async (t) => {
  if (skip(t)) return;
  assert.equal(await open(ids.bob, ids.misForum), 200, 'a department member');
  assert.equal(await open(ids.ann, ids.misForum), 200, 'the head');
  assert.equal(await open(ids.cara, ids.misForum), 403, 'a member of another department');
  assert.equal(await open(ids.nodept, ids.misForum), 403, 'someone with no department');
  assert.equal(await open(ids.guest, ids.misForum), 403, 'a guest');
  assert.equal(await open(ids.owner, ids.misForum), 403, 'an Owner who is not a member, switch off');
});

test('the Owner switch opens it for an Owner, and moving a person out of the department closes it for them at once', async (t) => {
  if (skip(t)) return;
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = TRUE WHERE id = 1');
  assert.equal(await open(ids.owner, ids.misForum), 200, 'switch on');
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = FALSE WHERE id = 1');
  assert.equal(await open(ids.owner, ids.misForum), 403, 'switch off again');
  await admin.query('DELETE FROM user_departments WHERE user_id = $1 AND department_id = $2', [ids.bob, ids.mis]);
  assert.equal(await open(ids.bob, ids.misForum), 403, 'moved out');
  await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids.bob, ids.mis]);
  assert.equal(await open(ids.bob, ids.misForum), 200, 'moved back in');
});

test('the channel lists tell a forum from an ordinary channel and name its department', async (t) => {
  if (skip(t)) return;
  for (const path of ['/api/channels', '/api/channels/my']) {
    const channels = (await call(ids.bob, 'GET', path)).json.channels;
    const forum = channels.find((c) => c.id === ids.misForum);
    assert.equal(forum.kind, 'forum', path);
    assert.equal(forum.forumDepartmentId, ids.mis, path);
    const ordinary = channels.find((c) => c.kind !== 'forum');
    if (ordinary) { assert.equal(ordinary.kind, 'channel', path); assert.equal(ordinary.forumDepartmentId, null, path); }
  }
});

test('creating a department creates its forum', async (t) => {
  if (skip(t)) return;
  const created = await call(ids.owner, 'POST', '/api/hr/departments', { name: 'Finance Team' });
  assert.equal(created.status, 201);
  const forum = await forumOf(created.json.department.id);
  assert.equal(forum.name, 'dept-finance-team');
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM channel_department_grants WHERE channel_id = $1', [forum.id])).rows[0].n, 1);
});

test('renaming a department renames its forum, and a clash gets the id appended', async (t) => {
  if (skip(t)) return;
  const dept = (await call(ids.owner, 'POST', '/api/hr/departments', { name: 'Ops' })).json.department;
  assert.equal((await forumOf(dept.id)).name, 'dept-ops');
  assert.equal((await call(ids.owner, 'PUT', `/api/hr/departments/${dept.id}`, { name: 'Operations' })).status, 200);
  assert.equal((await forumOf(dept.id)).name, 'dept-operations');
  await admin.query("INSERT INTO channels (name) VALUES ('dept-taken')");
  await call(ids.owner, 'PUT', `/api/hr/departments/${dept.id}`, { name: 'Taken' });
  assert.equal((await forumOf(dept.id)).name, `dept-taken-${dept.id}`);
  await call(ids.owner, 'PUT', `/api/hr/departments/${dept.id}`, { name: 'Operations' });
  assert.equal((await forumOf(dept.id)).name, 'dept-operations', 'and back again');
});

test('changing the head moves the moderator row, and removing the head removes it', async (t) => {
  if (skip(t)) return;
  assert.deepEqual(await mods(ids.misForum), [ids.ann]);
  // Bob was made a moderator by hand (an Owner or manager did it), so syncing the head must leave him alone
  await admin.query("INSERT INTO channel_members (channel_id, user_id, role, membership_source) VALUES ($1, $2, 'moderator', 'manual') ON CONFLICT (channel_id, user_id) DO UPDATE SET role = 'moderator'", [ids.misForum, ids.bob]);
  assert.equal((await call(ids.owner, 'PUT', `/api/hr/departments/${ids.mis}`, { headId: ids.cara })).status, 200);
  assert.deepEqual(await mods(ids.misForum), [ids.bob, ids.cara].sort((a, b) => a - b), 'old head demoted away, new head in, a moderator someone else assigned is untouched');
  assert.equal((await call(ids.owner, 'PUT', `/api/hr/departments/${ids.mis}`, { headId: null })).status, 200);
  assert.deepEqual(await mods(ids.misForum), [ids.bob]);
  await call(ids.owner, 'PUT', `/api/hr/departments/${ids.mis}`, { headId: ids.ann });
  assert.ok((await mods(ids.misForum)).includes(ids.ann));
});

test('deactivating the head takes the moderator row away', async (t) => {
  if (skip(t)) return;
  const dept = (await call(ids.owner, 'POST', '/api/hr/departments', { name: 'Quality', headId: ids.cara })).json.department;
  const forum = await forumOf(dept.id);
  assert.ok((await mods(forum.id)).includes(ids.cara));
  const res = await call(ids.owner, 'POST', `/api/hr/employees/${ids.cara}/deactivate`, {});
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(!(await mods(forum.id)).includes(ids.cara));
});

test('deleting a department archives its forum and keeps its topics', async (t) => {
  if (skip(t)) return;
  const dept = (await call(ids.owner, 'POST', '/api/hr/departments', { name: 'Temporary' })).json.department;
  const forum = await forumOf(dept.id);
  await admin.query("INSERT INTO forum_topics (channel_id, title, created_by) VALUES ($1, 'kept', $2)", [forum.id, ids.owner]);
  assert.equal((await call(ids.owner, 'DELETE', `/api/hr/departments/${dept.id}`)).status, 200);
  const after = (await admin.query('SELECT archived_at, forum_department_id FROM channels WHERE id = $1', [forum.id])).rows[0];
  assert.ok(after.archived_at, 'archived');
  assert.equal(after.forum_department_id, null);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM forum_topics WHERE channel_id = $1', [forum.id])).rows[0].n, 1, 'its topics are kept');
});
