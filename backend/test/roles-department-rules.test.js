// Roles given by department, through the /api/roles routes against a real PostgreSQL (scratch database).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config;
const ids = {};
const emitted = [];

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'roles-dept-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, superadmin = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', superadmin])).rows[0].id;
  ids.boss = await user('rd-boss', true);
  ids.lead = await user('rd-lead');
  for (const name of ['ann', 'bob', 'cara']) ids[name] = await user(`rd-${name}`);
  ids.mis = (await admin.query("INSERT INTO departments (name) VALUES ('rd-MIS') RETURNING id")).rows[0].id;
  ids.legal = (await admin.query("INSERT INTO departments (name) VALUES ('rd-Legal') RETURNING id")).rows[0].id;
  for (const [who, dept] of [['ann', 'mis'], ['bob', 'mis'], ['cara', 'legal']]) await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, true)', [ids[who], ids[dept]]);
  const app = express();
  app.use(express.json());
  const fakeIo = { emit: (event, payload) => emitted.push({ event, payload }) };
  app.use('/api/roles', (req, res, next) => { req.io = fakeIo; next(); }, require('../src/routes/roles'));
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
const call = async (userId, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/roles${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const holds = async (user, role) => (await admin.query('SELECT auto FROM user_roles WHERE user_id = $1 AND role_id = $2', [user, role])).rows[0];

test('choosing a department for a role gives it to the department\'s members at once and tells the Roles screen', async (t) => {
  if (skip(t)) return;
  ids.tools = (await call(ids.boss, 'POST', '/', { name: 'MIS tools', permissions: ['send_messages'] })).json.role.id;
  const set = await call(ids.boss, 'PUT', `/${ids.tools}/departments`, { departmentIds: [ids.mis] });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json, { departmentIds: [ids.mis], gained: 2, lost: 0 });
  assert.deepEqual(await holds(ids.ann, ids.tools), { auto: true });
  assert.deepEqual(await holds(ids.bob, ids.tools), { auto: true });
  assert.equal(await holds(ids.cara, ids.tools), undefined);
  const list = await call(ids.boss, 'GET', '/');
  assert.deepEqual(list.json.roles.find((r) => r.id === ids.tools).departmentIds, [ids.mis]);
  const table = await call(ids.boss, 'GET', '/assignments');
  assert.deepEqual(table.json.auto[ids.ann], [ids.tools]);
  assert.deepEqual(table.json.assignments[ids.ann], [ids.tools]);
  assert.ok(emitted.some((e) => e.event === 'permissions_updated' && e.payload.userId === ids.ann));
  const audit = (await admin.query("SELECT details FROM moderation_audit_log WHERE action = 'roles_assigned' AND target_user_id = $1", [ids.ann])).rows;
  assert.equal(audit[0].details.source, 'department rule');
  assert.equal((await admin.query("SELECT 1 FROM moderation_audit_log WHERE action = 'role_departments_changed'")).rows.length, 1);
});

test('a role given by a department cannot be taken off one person by hand, and shows as given by the department', async (t) => {
  if (skip(t)) return;
  const attempt = await call(ids.boss, 'PUT', `/users/${ids.ann}`, { roleIds: [] });
  assert.equal(attempt.status, 200);
  assert.deepEqual(attempt.json.roleIds, [ids.tools], 'still held');
  assert.deepEqual(await holds(ids.ann, ids.tools), { auto: true });
  const one = await call(ids.boss, 'GET', `/users/${ids.ann}`);
  assert.deepEqual(one.json.roleIds, [ids.tools]);
  assert.deepEqual(one.json.autoRoleIds, [ids.tools]);
});

test('the built-in Owner and Everyone roles cannot be given by a department', async (t) => {
  if (skip(t)) return;
  const roles = (await call(ids.boss, 'GET', '/')).json.roles;
  for (const key of ['owner', 'everyone']) {
    const builtin = roles.find((r) => r.builtin === key);
    const result = await call(ids.boss, 'PUT', `/${builtin.id}/departments`, { departmentIds: [ids.mis] });
    assert.equal(result.status, 400, key);
  }
});

test('bad input is refused: unknown department, not a list, an unknown role', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.boss, 'PUT', `/${ids.tools}/departments`, { departmentIds: [999999] })).status, 400);
  assert.equal((await call(ids.boss, 'PUT', `/${ids.tools}/departments`, { departmentIds: 'mis' })).status, 400);
  assert.equal((await call(ids.boss, 'PUT', '/999999/departments', { departmentIds: [] })).status, 404);
});

test('only someone who manages roles may set it, and only for roles below their own', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'PUT', `/${ids.tools}/departments`, { departmentIds: [] })).status, 403);
  const leadRole = (await call(ids.boss, 'POST', '/', { name: 'Team lead', permissions: ['manage_roles'] })).json.role.id;
  await admin.query('UPDATE roles SET position = 30 WHERE id = $1', [leadRole]);
  await admin.query('UPDATE roles SET position = 40 WHERE id = $1', [ids.tools]);
  await call(ids.boss, 'PUT', `/users/${ids.lead}`, { roleIds: [leadRole] });
  assert.equal((await call(ids.lead, 'PUT', `/${leadRole}/departments`, { departmentIds: [ids.mis] })).status, 403, 'their own rank');
  const below = await call(ids.lead, 'PUT', `/${ids.tools}/departments`, { departmentIds: [ids.mis, ids.legal] });
  assert.equal(below.status, 200);
  assert.deepEqual(below.json, { departmentIds: [ids.mis, ids.legal].sort((a, b) => a - b), gained: 1, lost: 0 });
  await admin.query('UPDATE roles SET position = 20 WHERE id = $1', [ids.tools]);
  assert.equal((await call(ids.lead, 'PUT', `/${ids.tools}/departments`, { departmentIds: [] })).status, 403, 'a role above theirs');
  await admin.query('UPDATE roles SET position = 100 WHERE id = $1', [ids.tools]);
});

test('a role someone was given by hand survives the rule being removed; the rest is taken back', async (t) => {
  if (skip(t)) return;
  await admin.query('UPDATE user_roles SET auto = false WHERE user_id = $1 AND role_id = $2', [ids.bob, ids.tools]);
  const removed = await call(ids.boss, 'PUT', `/${ids.tools}/departments`, { departmentIds: [] });
  assert.deepEqual(removed.json, { departmentIds: [], gained: 0, lost: 2 }, 'ann and cara lose it');
  assert.equal(await holds(ids.ann, ids.tools), undefined);
  assert.equal(await holds(ids.cara, ids.tools), undefined);
  assert.deepEqual(await holds(ids.bob, ids.tools), { auto: false });
});
