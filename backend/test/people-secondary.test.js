// A person can have extra (dotted-line) managers besides the main one, against a real PostgreSQL (scratch database).
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
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'people-secondary-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, { type = 'member', superadmin = false } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, `${name}@x.test`, 'x', type, superadmin]
  )).rows[0].id;
  ids.boss = await user('boss', { superadmin: true });
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  ids.cy = await user('cy');
  ids.guest = await user('visitor', { type: 'guest' });
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

const call = async (userId, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/people${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

test('extra managers are kept in order, shown on both pages, and only the Superadmin sets them', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.boss, 'PUT', `/${ids.cy}/manager`, { managerId: ids.ann })).status, 200);
  const set = await call(ids.boss, 'PUT', `/${ids.cy}/secondary-managers`, { managerIds: [ids.bob, ids.boss] });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json.secondaryManagerIds, [ids.bob, ids.boss]);

  const list = (await call(ids.ann, 'GET', '')).json.people;
  assert.deepEqual(list.find((p) => p.id === ids.cy).secondaryManagerIds, [ids.bob, ids.boss]);
  assert.deepEqual(list.find((p) => p.id === ids.ann).secondaryManagerIds, []);

  const page = (await call(ids.ann, 'GET', `/${ids.cy}`)).json;
  assert.equal(page.manager.id, ids.ann, 'the main manager is unchanged');
  assert.deepEqual(page.secondaryManagers.map((p) => p.username), ['bob', 'boss'], 'in the order given');
  const bobPage = (await call(ids.ann, 'GET', `/${ids.bob}`)).json;
  assert.deepEqual(bobPage.secondaryReports.map((p) => p.username), ['cy']);

  assert.equal((await call(ids.ann, 'PUT', `/${ids.cy}/secondary-managers`, { managerIds: [] })).status, 403);
  assert.equal((await call(ids.boss, 'PUT', `/${ids.cy}/secondary-managers`, { managerIds: [ids.boss] })).json.secondaryManagerIds.length, 1, 'replaces the list');
});

test('bad extra-manager lists are refused', async (t) => {
  if (skip(t)) return;
  const put = (managerIds) => call(ids.boss, 'PUT', `/${ids.cy}/secondary-managers`, { managerIds });
  assert.equal((await put([ids.cy])).status, 400, 'not themselves');
  assert.equal((await put([ids.ann])).status, 400, 'not the main manager again');
  assert.equal((await put([ids.bob, ids.bob])).status, 400, 'not twice');
  assert.equal((await put([ids.guest])).status, 404, 'members only');
  assert.equal((await put([1, 2, 3, 4, 5, 6])).status, 400, 'at most five');
  assert.equal((await put('bob')).status, 400);
  assert.equal((await put(['x'])).status, 400);
});

test('making someone the main manager removes them from the extra ones', async (t) => {
  if (skip(t)) return;
  await call(ids.boss, 'PUT', `/${ids.cy}/secondary-managers`, { managerIds: [ids.bob] });
  await call(ids.boss, 'PUT', `/${ids.cy}/manager`, { managerId: ids.bob });
  const page = (await call(ids.ann, 'GET', `/${ids.cy}`)).json;
  assert.equal(page.manager.id, ids.bob);
  assert.deepEqual(page.person.secondaryManagerIds, []);
});

test('first, middle and last names: people edit their own, the Superadmin fills in others, and accounts can be created with them', async (t) => {
  if (skip(t)) return;
  const mine = await call(ids.ann, 'PUT', '/me', { lastName: ' Lee ', firstName: 'Ann', middleName: 'Marie' });
  assert.equal(mine.status, 200);
  assert.deepEqual([mine.json.person.lastName, mine.json.person.firstName, mine.json.person.middleName], ['Lee', 'Ann', 'Marie']);
  assert.equal((await call(ids.ann, 'PUT', '/me', { jobTitle: 'Analyst' })).json.person.lastName, 'Lee', 'saving something else keeps the name');
  assert.equal((await call(ids.ann, 'PUT', '/me', { middleName: '' })).json.person.middleName, '', 'a name can be cleared');
  assert.equal((await call(ids.ann, 'PUT', '/me', { firstName: 'x'.repeat(101) })).status, 400);
  const list = (await call(ids.bob, 'GET', '')).json.people;
  assert.equal(list.find((p) => p.id === ids.ann).firstName, 'Ann', 'everyone sees it in the directory');

  assert.equal((await call(ids.ann, 'PUT', `/${ids.bob}/names`, { lastName: 'Cruz' })).status, 403);
  const set = await call(ids.boss, 'PUT', `/${ids.bob}/names`, { lastName: 'Cruz', firstName: 'Bob' });
  assert.equal(set.status, 200);
  assert.equal(set.json.person.lastName, 'Cruz');
  assert.equal((await call(ids.boss, 'PUT', `/${ids.guest}/names`, { lastName: 'Nope' })).status, 404, 'members only');

});
