// Managing roles: the hierarchy rules (pure) and the /api/roles routes against a real PostgreSQL (scratch database).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { actorProfile, canManageRole, ungrantable, cleanRoleInput } = require('../src/roles');
const { createScratchDatabase } = require('./helpers/scratchDb');

test('rank: an Owner is 0, others rank by their highest role, a person with no role cannot manage any', () => {
  const owner = actorProfile({ isOwner: true, roles: [{ builtin_key: 'everyone', position: 1000, permissions: [] }] });
  assert.equal(owner.rank, 0);
  const lead = actorProfile({ isOwner: false, roles: [{ builtin_key: 'everyone', position: 1000, permissions: [] }, { builtin_key: null, position: 30, permissions: ['manage_roles'] }] });
  assert.equal(lead.rank, 30);
  const nobody = actorProfile({ isOwner: false, roles: [{ builtin_key: 'everyone', position: 1000, permissions: [] }] });
  assert.equal(nobody.rank, Infinity);
  assert.equal(canManageRole(nobody, { builtin_key: null, position: 500 }), false);
});

test('you manage only roles ranked below yours; nobody manages Owner', () => {
  const lead = actorProfile({ isOwner: false, roles: [{ builtin_key: null, position: 30, permissions: ['manage_roles'] }] });
  assert.equal(canManageRole(lead, { builtin_key: null, position: 40 }), true);
  assert.equal(canManageRole(lead, { builtin_key: null, position: 30 }), false, 'same rank');
  assert.equal(canManageRole(lead, { builtin_key: null, position: 20 }), false, 'higher rank');
  assert.equal(canManageRole(lead, { builtin_key: 'owner', position: 0 }), false);
  const owner = actorProfile({ isOwner: true, roles: [] });
  assert.equal(canManageRole(owner, { builtin_key: 'owner', position: 0 }), false, 'not even an Owner');
  assert.equal(canManageRole(owner, { builtin_key: 'hr', position: 10 }), true);
});

test('you may only give permissions you hold', () => {
  const lead = actorProfile({ isOwner: false, roles: [{ builtin_key: null, position: 30, permissions: ['manage_roles', 'manage_messages'] }] });
  assert.deepEqual(ungrantable(lead, ['manage_messages', 'manage_people']), ['manage_people']);
});

test('role input is cleaned: name, color and known permissions only', () => {
  assert.equal(cleanRoleInput({ name: '  ' }).error, 'Give the role a name');
  assert.ok(cleanRoleInput({ name: 'x'.repeat(41) }).error);
  assert.ok(cleanRoleInput({ name: 'Ok', color: 'red' }).error);
  assert.ok(cleanRoleInput({ name: 'Ok', permissions: ['fly'] }).error);
  assert.deepEqual(cleanRoleInput({ name: ' Team   lead ', color: '#abcdef', permissions: ['send_messages', 'send_messages'] }), { name: 'Team lead', color: '#ABCDEF', permissions: ['send_messages'] });
  const hr = { name: 'HR', color: '#0F766E', permissions: ['manage_people'], builtin_key: 'hr' };
  assert.equal(cleanRoleInput({ name: 'Renamed', permissions: [] }, hr).name, 'HR', 'a built-in keeps its name');
});

let scratch;
let admin;
let server;
let baseUrl;
let pool;
let config;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'roles-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, { superadmin = false } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, `${name}@x.test`, 'x', superadmin]
  )).rows[0].id;
  ids.boss = await user('boss', { superadmin: true });
  ids.lead = await user('lead');
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  const app = express();
  app.use(express.json());
  app.use('/api/roles', require('../src/routes/roles'));
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

test('only someone with manage_roles can use the roles routes', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'GET', '/')).status, 403);
  assert.equal((await call(ids.ann, 'POST', '/', { name: 'Sneaky' })).status, 403);
  const list = await call(ids.boss, 'GET', '/');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.roles.map((r) => r.builtin), ['owner', 'hr', 'everyone']);
  assert.equal(list.json.roles.find((r) => r.builtin === 'owner').canManage, false);
});

test('an Owner creates, edits, orders and deletes a role, and each change is audited', async (t) => {
  if (skip(t)) return;
  const made = await call(ids.boss, 'POST', '/', { name: 'Team lead', color: '#112233', permissions: ['manage_roles', 'manage_messages'] });
  assert.equal(made.status, 201);
  ids.leadRole = made.json.role.id;
  assert.equal((await call(ids.boss, 'POST', '/', { name: 'team LEAD' })).status, 409, 'names are unique, ignoring case');
  const second = await call(ids.boss, 'POST', '/', { name: 'Support', permissions: ['send_messages'] });
  ids.supportRole = second.json.role.id;
  assert.ok(second.json.role.position > made.json.role.position);
  assert.equal((await call(ids.boss, 'PUT', `/${ids.supportRole}`, { name: 'Support desk', permissions: ['send_messages', 'attach_files'] })).status, 200);
  assert.equal((await call(ids.boss, 'PUT', `/${ids.supportRole}/move`, { direction: 'up' })).status, 200);
  const order = (await call(ids.boss, 'GET', '/')).json.roles.filter((r) => !r.builtin).map((r) => r.name);
  assert.deepEqual(order, ['Support desk', 'Team lead']);
  const audit = await admin.query("SELECT action FROM moderation_audit_log WHERE action LIKE 'role_%' ORDER BY id");
  assert.deepEqual(audit.rows.map((r) => r.action), ['role_created', 'role_created', 'role_updated', 'role_moved']);
});

test('built-in roles: Owner is untouchable; HR and Everyone keep their name but their permissions can change; none can be deleted', async (t) => {
  if (skip(t)) return;
  const roles = (await call(ids.boss, 'GET', '/')).json.roles;
  const owner = roles.find((r) => r.builtin === 'owner');
  const hr = roles.find((r) => r.builtin === 'hr');
  assert.equal((await call(ids.boss, 'PUT', `/${owner.id}`, { permissions: [] })).status, 403);
  const edited = await call(ids.boss, 'PUT', `/${hr.id}`, { name: 'Renamed', permissions: ['manage_people', 'view_audit_log'] });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.role.name, 'HR');
  assert.deepEqual(edited.json.role.permissions, ['manage_people', 'view_audit_log']);
  assert.equal((await call(ids.boss, 'DELETE', `/${hr.id}`)).status, 400);
});

test('the hierarchy: a team lead manages roles below theirs and cannot raise anyone, or grant what they lack', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.boss, 'PUT', `/users/${ids.lead}`, { roleIds: [ids.leadRole] })).status, 200);
  assert.equal((await call(ids.lead, 'GET', '/')).status, 200, 'the role grants manage_roles');
  // cannot edit their own role or anything above it
  assert.equal((await call(ids.lead, 'PUT', `/${ids.leadRole}`, { permissions: ['manage_roles'] })).status, 403);
  // may create a role below theirs, with permissions they hold
  const below = await call(ids.lead, 'POST', '/', { name: 'Helper', permissions: ['manage_messages'] });
  assert.equal(below.status, 201);
  assert.ok(below.json.role.position > 0);
  // but not one with a permission they do not have
  assert.equal((await call(ids.lead, 'POST', '/', { name: 'Too much', permissions: ['manage_people'] })).status, 403);
  // may give the lower role, but not their own
  assert.equal((await call(ids.lead, 'PUT', `/users/${ids.ann}`, { roleIds: [below.json.role.id] })).status, 200);
  assert.equal((await call(ids.lead, 'PUT', `/users/${ids.bob}`, { roleIds: [ids.leadRole] })).status, 403);
  // taking away a role they may not manage is refused too
  assert.equal((await call(ids.lead, 'PUT', `/users/${ids.lead}`, { roleIds: [] })).status, 403);
  ids.helperRole = below.json.role.id;
});

test('giving a role takes effect at once, and deleting a role removes it from everyone', async (t) => {
  if (skip(t)) return;
  const { can } = require('../src/permissions');
  const query = (sql, params) => admin.query(sql, params);
  assert.equal(await can(query, ids.ann, 'manage_messages'), true);
  assert.equal((await call(ids.lead, 'DELETE', `/${ids.helperRole}`)).status, 200);
  assert.equal(await can(query, ids.ann, 'manage_messages'), false);
  assert.equal((await call(ids.boss, 'GET', `/users/${ids.ann}`)).json.roleIds.length, 0);
});

test('the assignment table data lists every person\'s custom roles and who is Owner or HR', async (t) => {
  if (skip(t)) return;
  const made = await call(ids.boss, 'POST', '/', { name: 'Table role', permissions: ['send_messages'] });
  await call(ids.boss, 'PUT', `/users/${ids.bob}`, { roleIds: [made.json.role.id] });
  const data = await call(ids.boss, 'GET', '/assignments');
  assert.equal(data.status, 200);
  assert.deepEqual(data.json.assignments[ids.bob], [made.json.role.id]);
  assert.deepEqual(data.json.owners, [ids.boss]);
  assert.equal((await call(ids.ann, 'GET', '/assignments')).status, 403);
});

test('a person\'s roles come with them in the people directory, highest rank first', async (t) => {
  if (skip(t)) return;
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/people', require('../src/routes/people'));
  const srv = http.createServer(app2);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/people`, { headers: { Authorization: `Bearer ${jwt.sign({ userId: ids.boss, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}` } });
    const people = (await res.json()).people;
    const bob = people.find((p) => p.id === ids.bob);
    assert.deepEqual(bob.roles.map((r) => r.name), ['Table role']);
    assert.ok(/^#[0-9A-F]{6}$/i.test(bob.roles[0].color));
    assert.deepEqual(people.find((p) => p.id === ids.ann).roles, []);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
