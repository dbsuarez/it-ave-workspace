// Channel overrides: the routes that set them, and that viewing, posting and attaching honor them (real PostgreSQL).
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
let security;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'chperm-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  security = require('../src/security');
  const user = async (name, { superadmin = false } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, `${name}@x.test`, 'x', superadmin]
  )).rows[0].id;
  ids.boss = await user('boss', { superadmin: true });
  ids.maker = await user('maker');
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  ids.channel = (await admin.query("INSERT INTO channels (name, created_by) VALUES ('chperm-news', $1) RETURNING id", [ids.maker])).rows[0].id;
  for (const id of [ids.maker, ids.ann, ids.bob]) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.channel, id]);
  ids.everyone = (await admin.query("SELECT id FROM roles WHERE builtin_key = 'everyone'")).rows[0].id;
  ids.editors = (await admin.query("INSERT INTO roles (name, position, permissions) VALUES ('Editors', 50, '{}') RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.ann, ids.editors]);
  const app = express();
  app.use(express.json());
  app.use('/api/channels', require('../src/routes/channelPermissions'));
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
const query = (sql, params) => admin.query(sql, params);
const call = async (userId, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/channels${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const canPost = async (userId) => security.ensureCanPostToChannel(query, userId, ids.channel).then(() => true, (err) => (err.status === 403 ? false : Promise.reject(err)));
const canView = async (userId) => security.ensureChannelMembership(query, userId, ids.channel).then(() => true, (err) => (err.status === 403 ? false : Promise.reject(err)));

test('only the creator, an Owner or a role with manage_channels may read or change a channel\'s permissions', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'GET', `/${ids.channel}/permissions`)).status, 403);
  assert.equal((await call(ids.maker, 'GET', `/${ids.channel}/permissions`)).status, 200);
  assert.equal((await call(ids.boss, 'GET', `/${ids.channel}/permissions`)).status, 200);
  const listed = (await call(ids.boss, 'GET', `/${ids.channel}/permissions`)).json;
  assert.deepEqual(listed.roles.map((r) => r.builtin), ['hr', null, 'everyone'], 'Owner is not listed: it always has everything');
});

test('a read-only channel: Everyone cannot post, the Editors role can, and the creator is unaffected only when allowed', async (t) => {
  if (skip(t)) return;
  assert.equal(await canPost(ids.bob), true, 'before: anyone in the channel can post');
  const set = (body) => call(ids.maker, 'PUT', `/${ids.channel}/permissions`, body);
  assert.equal((await set({ subjectType: 'role', subjectId: ids.everyone, allow: [], deny: ['send_messages'] })).status, 200);
  assert.equal((await set({ subjectType: 'role', subjectId: ids.editors, allow: ['send_messages'], deny: [] })).status, 200);
  assert.equal(await canPost(ids.bob), false, 'Everyone is denied');
  assert.equal(await canPost(ids.ann), true, 'a role allow lifts it');
  assert.equal(await canPost(ids.boss), true, 'an Owner always may');
  // a personal allow
  assert.equal((await set({ subjectType: 'user', subjectId: ids.bob, allow: ['send_messages'], deny: [] })).status, 200);
  assert.equal(await canPost(ids.bob), true);
  // removing the overrides restores the default
  for (const [type, id] of [['role', ids.everyone], ['role', ids.editors], ['user', ids.bob]]) await set({ subjectType: type, subjectId: id, allow: [], deny: [] });
  assert.equal(await canPost(ids.bob), true);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM channel_overrides WHERE channel_id = $1', [ids.channel])).rows[0].n, 0);
});

test('a private room for a role: Everyone cannot see the channel, Editors can', async (t) => {
  if (skip(t)) return;
  const set = (body) => call(ids.maker, 'PUT', `/${ids.channel}/permissions`, body);
  await set({ subjectType: 'role', subjectId: ids.everyone, allow: [], deny: ['view_channel'] });
  await set({ subjectType: 'role', subjectId: ids.editors, allow: ['view_channel'], deny: [] });
  assert.equal(await canView(ids.bob), false);
  assert.equal(await canView(ids.ann), true);
  assert.equal(await canView(ids.boss), true);
  await set({ subjectType: 'role', subjectId: ids.everyone, allow: [], deny: [] });
  await set({ subjectType: 'role', subjectId: ids.editors, allow: [], deny: [] });
  assert.equal(await canView(ids.bob), true);
});

test('a department override follows the employee department without copied channel memberships', async (t) => {
  if (skip(t)) return;
  const departmentId = (await query("INSERT INTO departments (name) VALUES ('Engineering test') RETURNING id")).rows[0].id;
  await query('UPDATE users SET department_id = $1 WHERE id = $2', [departmentId, ids.bob]);
  await query('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [ids.channel, ids.bob]);
  const set = (body) => call(ids.maker, 'PUT', `/${ids.channel}/permissions`, body);
  assert.equal((await set({ subjectType: 'role', subjectId: ids.everyone, allow: [], deny: ['view_channel', 'send_messages'] })).status, 200);
  assert.equal((await set({ subjectType: 'department', subjectId: departmentId, allow: ['view_channel', 'send_messages'], deny: [] })).status, 200);
  assert.equal(await canView(ids.bob), true, 'membership is granted from the current department');
  assert.equal(await canPost(ids.bob), true, 'department allow overrides Everyone deny');
  const listed = (await call(ids.maker, 'GET', `/${ids.channel}/permissions`)).json;
  assert.ok(listed.departments.some((department) => department.id === departmentId && department.memberCount === 1));
  await set({ subjectType: 'role', subjectId: ids.everyone, allow: [], deny: [] });
  await set({ subjectType: 'department', subjectId: departmentId, allow: [], deny: [] });
  await query('UPDATE users SET department_id = NULL WHERE id = $1', [ids.bob]);
  await query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ids.channel, ids.bob]);
});

test('editing the Everyone role itself changes what members can do everywhere', async (t) => {
  if (skip(t)) return;
  await query("UPDATE roles SET permissions = array_remove(permissions, 'send_messages') WHERE builtin_key = 'everyone'");
  assert.equal(await canPost(ids.bob), false);
  await query("UPDATE roles SET permissions = array_append(permissions, 'send_messages') WHERE builtin_key = 'everyone'");
  assert.equal(await canPost(ids.bob), true);
});

test('bad requests are refused: unknown permission, contradiction, Owner, missing people', async (t) => {
  if (skip(t)) return;
  const set = (body) => call(ids.maker, 'PUT', `/${ids.channel}/permissions`, body);
  assert.equal((await set({ subjectType: 'role', subjectId: ids.everyone, allow: ['fly'], deny: [] })).status, 400);
  assert.equal((await set({ subjectType: 'role', subjectId: ids.everyone, allow: ['send_messages'], deny: ['send_messages'] })).status, 400);
  const owner = (await query("SELECT id FROM roles WHERE builtin_key = 'owner'")).rows[0].id;
  assert.equal((await set({ subjectType: 'role', subjectId: owner, allow: [], deny: ['send_messages'] })).status, 400);
  assert.equal((await set({ subjectType: 'user', subjectId: 99999, allow: ['send_messages'], deny: [] })).status, 404);
  assert.equal((await call(ids.ann, 'PUT', `/${ids.channel}/permissions`, { subjectType: 'role', subjectId: ids.everyone, allow: [], deny: ['send_messages'] })).status, 403);
});

test('a channel someone may not see is left out of their channel list', async (t) => {
  if (skip(t)) return;
  const { viewableChannels } = require('../src/permissions');
  const rows = [{ id: ids.channel }];
  assert.equal((await viewableChannels(query, ids.bob, rows)).length, 1);
  await call(ids.maker, 'PUT', `/${ids.channel}/permissions`, { subjectType: 'role', subjectId: ids.everyone, allow: [], deny: ['view_channel'] });
  assert.equal((await viewableChannels(query, ids.bob, rows)).length, 0, 'denied');
  assert.equal((await viewableChannels(query, ids.boss, rows)).length, 1, 'an Owner still sees it');
  await call(ids.maker, 'PUT', `/${ids.channel}/permissions`, { subjectType: 'role', subjectId: ids.everyone, allow: [], deny: [] });
  assert.equal((await viewableChannels(query, ids.bob, rows)).length, 1);
});
