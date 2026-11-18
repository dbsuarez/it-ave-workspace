// Sheets: creating, access, saving with a revision, renaming, sharing and deleting, against a real PostgreSQL (scratch database).
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
  process.env.JWT_SECRET = 'sheets-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const add = async (name, extra = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, `${name}@x.test`, 'x', extra.type || 'member', Boolean(extra.owner)])).rows[0].id;
  ids.boss = await add('sh-boss', { owner: true });
  for (const name of ['hr', 'plain', 'ed', 'vi', 'out']) ids[name] = await add(`sh-${name}`);
  ids.guest = await add('sh-guest', { type: 'guest' });
  const role = (await admin.query("INSERT INTO roles (name, permissions) VALUES ('sh-sheet-makers', '{manage_sheets}') RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.hr, role]);
  const app = express();
  app.use('/api/sheets', require('../src/routes/sheets'));
  app.use(express.json());
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
const call = async (user, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/sheets${path}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[user], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const tab = (name, rows = [], id) => ({ ...(id ? { id } : {}), name, rows });
const data = (...tabs) => ({ tabs });

test('only someone with Manage sheets (or an Owner) can create a sheet, and it starts with one empty tab', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('plain', 'POST', '', { title: 'Nope' })).status, 403);
  assert.equal((await call('guest', 'POST', '', { title: 'Nope' })).status, 403);
  const made = await call('hr', 'POST', '', { title: '  Holidays 2027  ' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.sheet.title, 'Holidays 2027');
  assert.equal(made.json.sheet.role, 'editor');
  assert.equal(made.json.sheet.revision, 1);
  ids.sheet = made.json.sheet.id;
  const opened = await call('hr', 'GET', `/${ids.sheet}`);
  assert.equal(opened.json.data.tabs.length, 1);
  assert.equal(opened.json.data.tabs[0].name, 'Sheet1');
  assert.ok(opened.json.data.tabs[0].id, 'a tab has an id of its own, so renaming it keeps what points at it');
  assert.equal((await call('boss', 'POST', '', { title: 'An Owner may' })).status, 201);
});

test('a sheet can be made with its data already in it, and bad titles or data are refused', async (t) => {
  if (skip(t)) return;
  const made = await call('hr', 'POST', '', { title: 'Credits', data: data(tab('Credits', [['Name', 'Days'], ['ann', '12']])) });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const back = (await call('hr', 'GET', `/${made.json.sheet.id}`)).json.data;
  assert.deepEqual(back.tabs[0].rows, [['Name', 'Days'], ['ann', '12']]);
  for (const body of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(121) }, { title: 5 }, {}]) assert.equal((await call('hr', 'POST', '', body)).status, 400, JSON.stringify(body));
  const bad = [
    data(), { tabs: 'x' }, data(...Array.from({ length: 21 }, (_, i) => tab(`T${i}`))), data(tab('')), data(tab('x'.repeat(32))),
    data(tab('A'), tab('a')), data(tab('A', 'no')), data(tab('A', [[5]])), data(tab('A', [['x'.repeat(5001)]])),
    data(tab('A', Array.from({ length: 5001 }, () => []))), data(tab('A', [Array.from({ length: 201 }, () => '')])),
  ];
  for (const d of bad) assert.equal((await call('hr', 'POST', '', { title: 'Bad', data: d })).status, 400, JSON.stringify(d).slice(0, 50));
});

test('the sheets you made are under mine, and the ones shared with you are under shared', async (t) => {
  if (skip(t)) return;
  const mine = await call('hr', 'GET', '?scope=mine');
  assert.ok(mine.json.sheets.some((s) => s.id === ids.sheet));
  assert.equal((await call('plain', 'GET', '?scope=mine')).json.sheets.length, 0);
  assert.equal(mine.json.canCreate, true, 'the list says whether this person may make new sheets, so the screen can show the button');
  assert.equal((await call('plain', 'GET', '?scope=mine')).json.canCreate, false);
  assert.equal((await call('hr', 'PUT', `/${ids.sheet}/members/${ids.ed}`, { role: 'editor' })).status, 200);
  assert.equal((await call('hr', 'PUT', `/${ids.sheet}/members/${ids.vi}`, { role: 'viewer' })).status, 200);
  const shared = await call('ed', 'GET', '?scope=shared');
  assert.deepEqual(shared.json.sheets.map((s) => [s.id, s.role]), [[ids.sheet, 'editor']]);
  assert.equal((await call('ed', 'GET', '?scope=mine')).json.sheets.length, 0);
  assert.equal((await call('hr', 'GET', '')).status, 400, 'a list needs a scope');
});

test('opening a sheet: the owner sees the members, a viewer gets the viewer role, an outsider and an Owner of the workspace are refused', async (t) => {
  if (skip(t)) return;
  const owner = await call('hr', 'GET', `/${ids.sheet}`);
  assert.equal(owner.json.sheet.role, 'editor');
  assert.deepEqual(owner.json.members.map((m) => [m.username, m.role]).sort(), [['sh-ed', 'editor'], ['sh-vi', 'viewer']]);
  const viewer = await call('vi', 'GET', `/${ids.sheet}`);
  assert.equal(viewer.json.sheet.role, 'viewer');
  assert.equal(viewer.json.members, undefined, 'only the owner sees who it is shared with');
  assert.equal((await call('out', 'GET', `/${ids.sheet}`)).status, 403);
  assert.equal((await call('boss', 'GET', `/${ids.sheet}`)).status, 403, 'being an Owner of the workspace does not open other people\'s sheets');
  assert.equal((await call('hr', 'GET', '/999999')).status, 404);
});

test('saving needs the latest revision: it goes up by one, and a stale save is refused with the latest sheet so the browser can merge', async (t) => {
  if (skip(t)) return;
  const current = (await call('ed', 'GET', `/${ids.sheet}`)).json;
  const tabId = current.data.tabs[0].id;
  const first = await call('ed', 'PUT', `/${ids.sheet}/data`, { baseRevision: current.sheet.revision, data: data(tab('Sheet1', [['A1', 'B1']], tabId)) });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.revision, current.sheet.revision + 1);
  const stale = await call('hr', 'PUT', `/${ids.sheet}/data`, { baseRevision: current.sheet.revision, data: data(tab('Sheet1', [['mine']], tabId)) });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.revision, first.json.revision);
  assert.deepEqual(stale.json.data.tabs[0].rows, [['A1', 'B1']]);
  const again = await call('hr', 'PUT', `/${ids.sheet}/data`, { baseRevision: stale.json.revision, data: data(tab('Sheet1', [['A1', 'B1'], ['more']], tabId)) });
  assert.equal(again.status, 200);
  assert.equal((await call('vi', 'PUT', `/${ids.sheet}/data`, { baseRevision: again.json.revision, data: data(tab('Sheet1', [['no']], tabId)) })).status, 403, 'a viewer cannot save');
  assert.equal((await call('out', 'PUT', `/${ids.sheet}/data`, { baseRevision: 1, data: data(tab('Sheet1')) })).status, 403);
  assert.equal((await call('ed', 'PUT', `/${ids.sheet}/data`, { data: data(tab('Sheet1')) })).status, 400, 'a revision is needed');
  assert.equal((await call('ed', 'PUT', `/${ids.sheet}/data`, { baseRevision: again.json.revision, data: { tabs: [] } })).status, 400);
});

test('renaming needs an editor; deleting and sharing are the owner\'s', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('ed', 'PATCH', `/${ids.sheet}`, { title: 'Holidays' })).json.sheet.title, 'Holidays');
  assert.equal((await call('vi', 'PATCH', `/${ids.sheet}`, { title: 'x' })).status, 403);
  assert.equal((await call('ed', 'PATCH', `/${ids.sheet}`, { title: '  ' })).status, 400);
  assert.equal((await call('ed', 'PUT', `/${ids.sheet}/members/${ids.out}`, { role: 'viewer' })).status, 403, 'an editor cannot share');
  assert.equal((await call('hr', 'PUT', `/${ids.sheet}/members/${ids.hr}`, { role: 'viewer' })).status, 400, 'the owner already has full access');
  assert.equal((await call('hr', 'PUT', `/${ids.sheet}/members/${ids.guest}`, { role: 'viewer' })).status, 400, 'no guests');
  assert.equal((await call('hr', 'PUT', `/${ids.sheet}/members/999999`, { role: 'viewer' })).status, 404);
  assert.equal((await call('hr', 'PUT', `/${ids.sheet}/members/${ids.out}`, { role: 'boss' })).status, 400);
  assert.equal((await call('hr', 'PUT', `/${ids.sheet}/members/${ids.out}`, { role: 'viewer' })).status, 200);
  assert.equal((await call('hr', 'DELETE', `/${ids.sheet}/members/${ids.out}`)).status, 200);
  assert.equal((await call('out', 'GET', `/${ids.sheet}`)).status, 403, 'removed');
  assert.equal((await call('ed', 'DELETE', `/${ids.sheet}`)).status, 403);
  assert.equal((await call('hr', 'DELETE', `/${ids.sheet}`)).status, 200);
  assert.equal((await call('hr', 'GET', `/${ids.sheet}`)).status, 404);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM sheet_members WHERE sheet_id = $1', [ids.sheet])).rows[0].n, 0, 'the sharing went with it');
});

test('a person who loses the Manage sheets permission keeps and can still edit the sheets they made', async (t) => {
  if (skip(t)) return;
  const made = await call('hr', 'POST', '', { title: 'Keep me' });
  await admin.query('DELETE FROM user_roles WHERE user_id = $1', [ids.hr]);
  const open = await call('hr', 'GET', `/${made.json.sheet.id}`);
  assert.equal(open.status, 200);
  assert.equal((await call('hr', 'PUT', `/${made.json.sheet.id}/data`, { baseRevision: open.json.sheet.revision, data: open.json.data })).status, 200);
  assert.equal((await call('hr', 'POST', '', { title: 'New one' })).status, 403, 'but cannot make new ones');
});
