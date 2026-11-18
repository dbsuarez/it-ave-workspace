// People > Directory / My team: the remembered card/list and active/inactive choices, and who may see inactive people.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'people-prefs-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const add = async (username, { type = 'member', superadmin = false, hr = false, manager = null, deactivated = false } = {}) => (await admin.query(
    `INSERT INTO users (username, email, password_hash, account_type, is_superadmin, is_hr, manager_id, deactivated_at)
     VALUES ($1, $2, 'x', $3, $4, $5, $6, $7) RETURNING id`,
    [username, `${username}@x.test`, type, superadmin, hr, manager, deactivated ? new Date() : null])).rows[0].id;
  ids.ann = await add('pv-ann');
  ids.bob = await add('pv-bob');
  ids.hr = await add('pv-hr');
  // HR is whoever holds a role with the manage_people permission (the old is_hr flag is not an authority)
  ids.hrRole = (await admin.query("SELECT id FROM roles WHERE 'manage_people' = ANY(permissions) AND builtin_key IS DISTINCT FROM 'owner' ORDER BY id LIMIT 1")).rows[0].id;
  await admin.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.hr, ids.hrRole]);
  ids.owner = await add('pv-owner', { superadmin: true });
  ids.guest = await add('pv-guest', { type: 'guest' });
  ids.leaverOfAnn = await add('pv-leaver-ann', { manager: ids.ann, deactivated: true });
  ids.leaverOther = await add('pv-leaver-other', { deactivated: true });
  ids.deadGuest = await add('pv-dead-guest', { type: 'guest', deactivated: true });
  ids.serviceLogin = await add('admin', { superadmin: true, deactivated: true });
  const app = express();
  app.use(express.json());
  app.use('/api/people', require('../src/routes/people'));
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
  const response = await fetch(`${baseUrl}/api/people${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const put = (userId, body) => call(userId, 'PUT', '/preferences', body);

test('new people start with cards and active only, and only HR and Owners can see inactive people', async (t) => {
  if (skip(t)) return;
  assert.deepEqual((await call(ids.ann, 'GET', '/preferences')).json, { view: 'card', status: 'active', canSeeInactive: false });
  assert.deepEqual((await call(ids.hr, 'GET', '/preferences')).json, { view: 'card', status: 'active', canSeeInactive: true });
  assert.equal((await call(ids.owner, 'GET', '/preferences')).json.canSeeInactive, true);
});

test('the choice is remembered per person on the server', async (t) => {
  if (skip(t)) return;
  const saved = await put(ids.ann, { view: 'list' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { view: 'list', status: 'active', canSeeInactive: false });
  assert.equal((await call(ids.ann, 'GET', '/preferences')).json.view, 'list', 'read back later (another device)');
  assert.equal((await call(ids.bob, 'GET', '/preferences')).json.view, 'card', 'nobody else is affected');
  assert.equal((await put(ids.ann, { view: 'card' })).json.view, 'card', 'and it can be changed back');
  const stored = (await admin.query('SELECT ui_prefs FROM users WHERE id = $1', [ids.ann])).rows[0].ui_prefs;
  assert.deepEqual(stored.people, { view: 'card', status: 'active' });
});

test('HR can remember Inactive; everyone else is refused, and losing HR falls back to Active', async (t) => {
  if (skip(t)) return;
  assert.equal((await put(ids.ann, { status: 'inactive' })).status, 403);
  assert.equal((await call(ids.ann, 'GET', '/preferences')).json.status, 'active');
  const saved = await put(ids.hr, { status: 'inactive', view: 'list' });
  assert.deepEqual(saved.json, { view: 'list', status: 'inactive', canSeeInactive: true });
  assert.equal((await call(ids.hr, 'GET', '/preferences')).json.status, 'inactive');
  await admin.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [ids.hr, ids.hrRole]);
  assert.deepEqual((await call(ids.hr, 'GET', '/preferences')).json, { view: 'list', status: 'active', canSeeInactive: false }, 'no longer HR: shown Active, view kept');
  await admin.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.hr, ids.hrRole]);
});

test('bad values are refused and change nothing; one field can be saved without touching the other', async (t) => {
  if (skip(t)) return;
  await put(ids.bob, { view: 'list' });
  assert.equal((await put(ids.bob, { view: 'grid' })).status, 400);
  assert.equal((await put(ids.bob, { status: 'everyone' })).status, 400);
  assert.equal((await put(ids.bob, { view: 42 })).status, 400);
  assert.equal((await put(ids.bob, {})).status, 400, 'nothing to save');
  assert.equal((await call(ids.bob, 'GET', '/preferences')).json.view, 'list');
});

test('guests have no preferences and no directory', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.guest, 'GET', '/preferences')).status, 403);
  assert.equal((await put(ids.guest, { view: 'list' })).status, 403);
});

test('GET /api/people?status=inactive lists only deactivated employees, and only for HR and Owners', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'GET', '?status=inactive')).status, 403);
  assert.equal((await call(ids.guest, 'GET', '?status=inactive')).status, 403);
  const names = async (who) => (await call(who, 'GET', '?status=inactive')).json.people.map((p) => p.username).sort();
  assert.deepEqual(await names(ids.hr), ['pv-leaver-ann', 'pv-leaver-other']);
  assert.deepEqual(await names(ids.owner), ['pv-leaver-ann', 'pv-leaver-other']);
  const leaver = (await call(ids.hr, 'GET', '?status=inactive')).json.people.find((p) => p.username === 'pv-leaver-ann');
  assert.equal(leaver.managerId, ids.ann, 'the old manager is there so My team can show former reports');
  assert.equal(leaver.inactive, true);
});

test('the normal list is unchanged: active members only, whatever the query says', async (t) => {
  if (skip(t)) return;
  const normal = (await call(ids.ann, 'GET', '')).json.people.map((p) => p.username);
  assert.ok(normal.includes('pv-bob') && !normal.some((n) => n.startsWith('pv-leaver') || n === 'admin' || n === 'pv-dead-guest' || n === 'pv-guest'));
  const withStatus = (await call(ids.ann, 'GET', '?status=active')).json.people.map((p) => p.username);
  assert.deepEqual(withStatus, normal);
  assert.equal((await call(ids.ann, 'GET', '?status=bogus')).status, 400);
});

test('"preferences" is its own route and not read as a person id', async (t) => {
  if (skip(t)) return;
  const r = await call(ids.ann, 'GET', '/preferences');
  assert.equal(r.status, 200);
  assert.ok('view' in r.json);
  assert.equal((await call(ids.ann, 'GET', `/${ids.leaverOther}`)).status, 404, 'a person page still hides inactive people');
});
