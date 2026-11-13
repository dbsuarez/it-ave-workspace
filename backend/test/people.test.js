// Employee pages, the directory and reporting lines, against a real PostgreSQL (scratch database).
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
  process.env.JWT_SECRET = 'people-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, { type = 'member', superadmin = false } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, `${name}@x.test`, 'x', type, superadmin]
  )).rows[0].id;
  ids.boss = await user('boss', { superadmin: true });
  ids.hiddenAdmin = await user('admin', { superadmin: true });
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  ids.cy = await user('cy');
  ids.guest = await user('visitor', { type: 'guest' });
  ids.bot = await user('helper', { type: 'bot' });
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

test('the directory lists members only, and guests cannot browse it', async (t) => {
  if (skip(t)) return;
  const list = await call(ids.ann, 'GET', '');
  assert.equal(list.status, 200);
  const names = list.json.people.map((p) => p.username);
  assert.deepEqual(names, ['ann', 'bob', 'boss', 'cy'], 'sorted, without the guest and the bot');
  assert.equal((await call(ids.guest, 'GET', '')).status, 403);
  assert.equal((await call(ids.guest, 'GET', `/${ids.ann}`)).status, 403);
  assert.equal((await call(ids.ann, 'GET', `/${ids.guest}`)).status, 404, 'a guest has no page in the directory');
  assert.equal((await call(ids.ann, 'GET', `/${ids.bot}`)).status, 404);
  assert.equal((await call(ids.ann, 'GET', '/abc')).status, 400);
});

test('the hidden admin can open their own personal page without appearing in the directory', async (t) => {
  if (skip(t)) return;
  const list = await call(ids.ann, 'GET', '');
  assert.ok(!list.json.people.some((person) => person.id === ids.hiddenAdmin));
  const own = await call(ids.hiddenAdmin, 'GET', `/${ids.hiddenAdmin}`);
  assert.equal(own.status, 200);
  assert.equal(own.json.person.username, 'admin');
  assert.equal((await call(ids.ann, 'GET', `/${ids.hiddenAdmin}`)).status, 404);
});

test('personal pages count visits from other employees and show the total to everyone', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.boss, 'GET', `/${ids.boss}`)).json.person.visits, 0, 'opening your own page is not a visit');
  assert.equal((await call(ids.ann, 'GET', `/${ids.boss}`)).json.person.visits, 1);
  assert.equal((await call(ids.bob, 'GET', `/${ids.boss}`)).json.person.visits, 2);
  assert.equal((await call(ids.boss, 'GET', `/${ids.boss}`)).json.person.visits, 2, 'the owner sees the same public count');
});

test('employees can like a personal page once, unlike it, and everyone sees the total', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.boss, 'PUT', `/${ids.boss}/like`, { liked: true })).status, 400, 'no self likes');
  assert.equal((await call(ids.guest, 'PUT', `/${ids.boss}/like`, { liked: true })).status, 403);
  assert.deepEqual((await call(ids.ann, 'PUT', `/${ids.boss}/like`, { liked: true })).json, { liked: true, likes: 1 });
  assert.deepEqual((await call(ids.ann, 'PUT', `/${ids.boss}/like`, { liked: true })).json, { liked: true, likes: 1 }, 'liking twice is still one like');
  assert.equal((await call(ids.bob, 'GET', `/${ids.boss}`)).json.person.likes, 1);
  assert.equal((await call(ids.ann, 'GET', `/${ids.boss}`)).json.person.likedByMe, true);
  assert.deepEqual((await call(ids.ann, 'PUT', `/${ids.boss}/like`, { liked: false })).json, { liked: false, likes: 0 });
});

test('someone customizes their own page', async (t) => {
  if (skip(t)) return;
  const saved = await call(ids.ann, 'PUT', '/me', {
    jobTitle: 'IT Manager', department: 'Ignored', location: 'Manila', phone: '+63 900 000 0000',
    about: 'I run the IT desk.',
    sections: [{ title: 'Ask me about', body: 'Networks, printers' }, { title: 'Hours', body: '8 to 5' }],
    links: [{ label: 'Wiki', url: 'https://wiki.example.com' }],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.person.department, '', 'the department is set by HR, not on the page');
  const seen = (await call(ids.bob, 'GET', `/${ids.ann}`)).json.person;
  assert.equal(seen.jobTitle, 'IT Manager');
  assert.equal(seen.about, 'I run the IT desk.');
  assert.deepEqual(seen.sections.map((s) => s.title), ['Ask me about', 'Hours']);
  assert.equal(seen.links[0].url, 'https://wiki.example.com');
  assert.equal(seen.phone, '+63 900 000 0000');
  assert.equal(seen.email, 'ann@x.test');
  assert.equal(seen.hide, undefined, 'the privacy switches are only shown to their owner');
  // a partial update changes only what is sent
  await call(ids.ann, 'PUT', '/me', { location: 'Cebu' });
  const after = (await call(ids.bob, 'GET', `/${ids.ann}`)).json.person;
  assert.equal(after.location, 'Cebu');
  assert.equal(after.sections.length, 2);
});

test('people can hide their email, phone and location from others, but not from themselves', async (t) => {
  if (skip(t)) return;
  await call(ids.ann, 'PUT', '/me', { phone: '555', location: 'Manila', hide: { email: true, phone: true, location: true } });
  const other = (await call(ids.bob, 'GET', `/${ids.ann}`)).json.person;
  assert.equal(other.email, '');
  assert.equal(other.phone, '');
  assert.equal(other.location, '');
  const listed = (await call(ids.bob, 'GET', '')).json.people.find((p) => p.id === ids.ann);
  assert.equal(listed.email, '', 'hidden in the directory too');
  assert.equal(listed.location, '');
  const mine = (await call(ids.ann, 'GET', `/${ids.ann}`)).json.person;
  assert.equal(mine.email, 'ann@x.test');
  assert.equal(mine.phone, '555');
  assert.deepEqual(mine.hide, { email: true, phone: true, location: true });
  await call(ids.ann, 'PUT', '/me', { hide: { email: false } });
  assert.equal((await call(ids.bob, 'GET', `/${ids.ann}`)).json.person.email, 'ann@x.test', 'switching one back on leaves the others');
  assert.equal((await call(ids.bob, 'GET', `/${ids.ann}`)).json.person.phone, '');
});

test('page content is validated and bounded', async (t) => {
  if (skip(t)) return;
  const bad = [
    { about: 'x'.repeat(1501) }, { phone: 'x'.repeat(41) },
    { sections: 'no' }, { sections: Array.from({ length: 9 }, () => ({ title: 't', body: '' })) }, { sections: [{ title: '', body: 'x' }] },
    { sections: [{ title: 't', body: 'x'.repeat(1501) }] },
    { links: [{ label: 'x', url: 'javascript:alert(1)' }] }, { links: [{ label: 'x', url: 'ftp://x.test' }] }, { links: [{ label: '', url: 'https://x.test' }] },
    { links: Array.from({ length: 9 }, () => ({ label: 'l', url: 'https://x.test' })) },
    { hide: { password: true } }, { hide: { email: 'yes' } }, { hide: [] },
  ];
  for (const body of bad) assert.equal((await call(ids.ann, 'PUT', '/me', body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await call(ids.ann, 'PUT', '/me', { about: '  trimmed  ' })).json.person.about, 'trimmed');
});

test('only the Superadmin sets reporting lines, with no loops', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'PUT', `/${ids.bob}/manager`, { managerId: ids.ann })).status, 403, 'an ordinary member cannot');
  assert.equal((await call(ids.boss, 'PUT', `/${ids.ann}/manager`, { managerId: ids.boss })).status, 200);
  assert.equal((await call(ids.boss, 'PUT', `/${ids.bob}/manager`, { managerId: ids.ann })).status, 200);
  assert.equal((await call(ids.boss, 'PUT', `/${ids.cy}/manager`, { managerId: ids.ann })).status, 200);
  // rules
  assert.equal((await call(ids.boss, 'PUT', `/${ids.ann}/manager`, { managerId: ids.ann })).status, 400, 'not themselves');
  assert.equal((await call(ids.boss, 'PUT', `/${ids.boss}/manager`, { managerId: ids.bob })).status, 400, 'a loop (boss > ann > bob > boss)');
  assert.equal((await call(ids.boss, 'PUT', `/${ids.ann}/manager`, { managerId: ids.cy })).status, 400, 'a loop one level down');
  assert.equal((await call(ids.boss, 'PUT', `/${ids.ann}/manager`, { managerId: ids.guest })).status, 404, 'a guest cannot be a manager');
  assert.equal((await call(ids.boss, 'PUT', `/${ids.guest}/manager`, { managerId: ids.boss })).status, 404);
  assert.equal((await call(ids.boss, 'PUT', `/${ids.ann}/manager`, { managerId: 'x' })).status, 400);
  assert.equal((await call(ids.boss, 'PUT', `/${ids.ann}/manager`, {})).status, 400);
  // the page shows both directions
  const page = (await call(ids.bob, 'GET', `/${ids.ann}`)).json;
  assert.equal(page.manager.username, 'boss');
  assert.deepEqual(page.reports.map((r) => r.username), ['bob', 'cy']);
  assert.equal(page.canSetManager, false);
  assert.equal((await call(ids.boss, 'GET', `/${ids.ann}`)).json.canSetManager, true);
  // the directory carries managerId, so it is also the org chart data
  const chart = (await call(ids.cy, 'GET', '')).json.people;
  assert.equal(chart.find((p) => p.username === 'bob').managerId, ids.ann);
  assert.equal(chart.find((p) => p.username === 'boss').managerId, null);
  // clearing a manager
  assert.equal((await call(ids.boss, 'PUT', `/${ids.cy}/manager`, { managerId: null })).status, 200);
  assert.equal((await call(ids.cy, 'GET', `/${ids.cy}`)).json.manager, null);
});

test('removing a manager account leaves their reports unassigned', async (t) => {
  if (skip(t)) return;
  const temp = (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ('temp', 'temp@x.test', 'x') RETURNING id")).rows[0].id;
  await call(ids.boss, 'PUT', `/${ids.cy}/manager`, { managerId: temp });
  await admin.query('DELETE FROM users WHERE id = $1', [temp]);
  assert.equal((await call(ids.cy, 'GET', `/${ids.cy}`)).json.person.managerId, null);
});
