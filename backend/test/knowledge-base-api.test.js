// Knowledge Base API against a real PostgreSQL (scratch database): who may read and manage, drafts, order, search, import.
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
  process.env.JWT_SECRET = 'kb-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const add = async (name, { type = 'member', owner = false, first = '', last = '' } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin, first_name, last_name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [name, `${name}@x.test`, 'x', type, owner, first, last])).rows[0].id;
  ids.boss = await add('kb-boss', { owner: true });
  ids.hr = await add('kb-hr', { first: 'Hana', last: 'Reyes' });
  ids.emp = await add('kb-emp');
  ids.guest = await add('kb-guest', { type: 'guest' });
  await admin.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE legacy_hr = true', [ids.hr]);
  const app = express();
  app.use('/api/kb', require('../src/routes/knowledgeBase'));
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
  const res = await fetch(`${baseUrl}/api/kb${path}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[user], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('HR and Owners manage the Knowledge Base; employees only read; guests are kept out', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('emp', 'POST', '/categories', { title: 'Leave' })).status, 403);
  assert.equal((await call('guest', 'POST', '/categories', { title: 'Leave' })).status, 403);
  assert.equal((await call('guest', 'GET', '/')).status, 403, 'a guest cannot read it');
  const made = await call('hr', 'POST', '/categories', { title: '  Leave  ' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.category.title, 'Leave');
  ids.leave = made.json.category.id;
  const second = await call('boss', 'POST', '/categories', { title: 'Employee Handbook' });
  assert.equal(second.status, 201, 'an Owner may too');
  ids.handbook = second.json.category.id;
  assert.equal((await call('hr', 'POST', '/categories', { title: '' })).status, 400);
  const home = await call('emp', 'GET', '/');
  assert.equal(home.status, 200);
  assert.equal(home.json.canManage, false);
  assert.deepEqual(home.json.categories, [], 'an employee does not see categories that have nothing published yet');
  const asHr = await call('hr', 'GET', '/');
  assert.equal(asHr.json.canManage, true);
  assert.deepEqual(asHr.json.categories.map((c) => c.title), ['Leave', 'Employee Handbook'], 'HR sees them all, in the order they were made');
});

test('an article starts as a draft only managers see; publishing shows it, with when and by whom it was last updated', async (t) => {
  if (skip(t)) return;
  const made = await call('hr', 'POST', '/articles', { categoryId: ids.leave, title: 'How do I file a leave?', body: '# Filing\n\nOpen **People**, then Leave.\n\n- Pick a type\n- Press Request' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  ids.filing = made.json.article.id;
  assert.equal(made.json.article.published, false);
  assert.equal((await call('emp', 'POST', '/articles', { categoryId: ids.leave, title: 'X', body: '' })).status, 403);

  assert.equal((await call('emp', 'GET', `/articles/${ids.filing}`)).status, 404, 'a draft is not there for an employee');
  assert.equal((await call('emp', 'GET', `/categories/${ids.leave}`)).json.articles.length, 0);
  assert.equal((await call('emp', 'GET', '/')).json.categories.length, 0);
  const asHr = await call('hr', 'GET', `/categories/${ids.leave}`);
  assert.equal(asHr.json.articles.length, 1);
  assert.equal(asHr.json.articles[0].published, false);
  assert.equal((await call('hr', 'GET', '/')).json.categories[0].draftCount, 1);
  assert.equal((await call('hr', 'GET', '/')).json.categories[0].articleCount, 0);

  const published = await call('hr', 'PATCH', `/articles/${ids.filing}`, { published: true });
  assert.equal(published.status, 200);
  const read = await call('emp', 'GET', `/articles/${ids.filing}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.article.title, 'How do I file a leave?');
  assert.equal(read.json.article.categoryTitle, 'Leave');
  assert.equal(read.json.article.updatedByName, 'Hana Reyes', 'the full name, not the username');
  assert.ok(Date.parse(read.json.article.updatedAt) > 0);
  assert.ok(read.json.sections.some((s) => s.type === 'heading'), 'the body comes back split into sections for the reading view');
  assert.ok(read.json.sections.some((s) => s.type === 'list'));
  assert.equal((await call('emp', 'GET', '/')).json.categories[0].articleCount, 1);
});

test('last updated moves when the text changes, not when the order does; the username is the fallback for the name', async (t) => {
  if (skip(t)) return;
  const before = (await call('hr', 'GET', `/articles/${ids.filing}`)).json.article.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await call('boss', 'POST', '/articles', { categoryId: ids.leave, title: 'Sick leave', body: 'Call your manager.', published: true });
  assert.equal(second.status, 201);
  ids.sick = second.json.article.id;
  assert.equal(second.json.article.updatedByName, 'kb-boss', 'no name filled in: the username');
  const order = await call('hr', 'PUT', `/categories/${ids.leave}/order`, { ids: [ids.sick, ids.filing] });
  assert.equal(order.status, 200, JSON.stringify(order.json));
  assert.deepEqual((await call('emp', 'GET', `/categories/${ids.leave}`)).json.articles.map((a) => a.title), ['Sick leave', 'How do I file a leave?']);
  assert.equal((await call('hr', 'GET', `/articles/${ids.filing}`)).json.article.updatedAt, before, 'reordering is not an edit');
  assert.equal((await call('hr', 'PUT', `/categories/${ids.leave}/order`, { ids: [ids.sick] })).status, 400, 'every article must be listed');
  assert.equal((await call('emp', 'PUT', `/categories/${ids.leave}/order`, { ids: [ids.filing, ids.sick] })).status, 403);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await call('hr', 'PATCH', `/articles/${ids.filing}`, { body: '# Filing\n\nUpdated steps.' });
  const after = (await call('hr', 'GET', `/articles/${ids.filing}`)).json.article.updatedAt;
  assert.ok(Date.parse(after) > Date.parse(before), 'editing moves it');
  const nav = (await call('emp', 'GET', `/articles/${ids.filing}`)).json.siblings;
  assert.equal(nav.previous.title, 'Sick leave');
  assert.equal(nav.next, null);
});

test('search finds published articles by title or text for employees, drafts too for managers, with a snippet', async (t) => {
  if (skip(t)) return;
  const draft = await call('hr', 'POST', '/articles', { categoryId: ids.handbook, title: 'Dress code', body: 'Wear a collared shirt on Fridays. 100% casual on weekends.' });
  const search = (user, q) => call(user, 'GET', `/search?q=${encodeURIComponent(q)}`);
  assert.equal((await search('emp', 'a')).status, 400, 'at least two characters');
  const byTitle = await search('emp', 'FILE a leave');
  assert.equal(byTitle.status, 200);
  assert.equal(byTitle.json.results[0].title, 'How do I file a leave?');
  assert.equal(byTitle.json.results[0].categoryTitle, 'Leave');
  const byText = await search('emp', 'steps');
  assert.equal(byText.json.results.length, 1);
  assert.match(byText.json.results[0].snippet, /Updated steps/);
  assert.equal((await search('emp', 'collared')).json.results.length, 0, 'a draft is hidden');
  assert.equal((await search('hr', 'collared')).json.results[0].id, draft.json.article.id, 'a manager finds it');
  assert.equal((await search('hr', '100%')).json.results.length, 1, '% is just a character');
  assert.equal((await search('hr', '%%')).json.results.length, 0);
  assert.equal((await search('guest', 'leave')).status, 403);
});

test('an import makes draft articles in order (or published ones) at the end of a category, and deleting a category removes them', async (t) => {
  if (skip(t)) return;
  const sections = [{ title: 'Welcome', body: 'Hello and welcome.' }, { title: 'Working hours', body: '| a | b |\n|---|---|\n| 8 | 5 |' }, { title: 'Leave policy', body: '' }];
  assert.equal((await call('emp', 'POST', `/categories/${ids.handbook}/import`, { articles: sections })).status, 403);
  assert.equal((await call('hr', 'POST', `/categories/${ids.handbook}/import`, { articles: [] })).status, 400);
  const imported = await call('hr', 'POST', `/categories/${ids.handbook}/import`, { articles: sections });
  assert.equal(imported.status, 201, JSON.stringify(imported.json));
  assert.equal(imported.json.created, 3);
  const listed = (await call('hr', 'GET', `/categories/${ids.handbook}`)).json.articles;
  assert.deepEqual(listed.map((a) => a.title), ['Dress code', 'Welcome', 'Working hours', 'Leave policy'], 'after what was already there, in the order given');
  assert.ok(listed.slice(1).every((a) => a.published === false), 'imported as drafts');
  const live = await call('hr', 'POST', `/categories/${ids.leave}/import`, { articles: [{ title: 'Emergency leave', body: 'x' }], publish: true });
  assert.equal(live.status, 201);
  assert.ok((await call('emp', 'GET', `/categories/${ids.leave}`)).json.articles.some((a) => a.title === 'Emergency leave'));

  assert.equal((await call('emp', 'DELETE', `/categories/${ids.handbook}`)).status, 403);
  assert.equal((await call('hr', 'DELETE', `/categories/${ids.handbook}`)).status, 200);
  assert.equal((await call('hr', 'GET', `/categories/${ids.handbook}`)).status, 404);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM kb_articles WHERE category_id = $1', [ids.handbook])).rows[0].n, 0, 'its articles went with it');
});

test('articles can be renamed, moved to another category and deleted; categories renamed and reordered', async (t) => {
  if (skip(t)) return;
  const other = (await call('hr', 'POST', '/categories', { title: 'Payroll' })).json.category.id;
  const moved = await call('hr', 'PATCH', `/articles/${ids.sick}`, { title: 'Sick leave policy', categoryId: other });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal((await call('emp', 'GET', `/articles/${ids.sick}`)).json.article.categoryTitle, 'Payroll');
  assert.equal((await call('hr', 'PATCH', `/articles/${ids.sick}`, { categoryId: 999999 })).status, 404);
  assert.equal((await call('hr', 'PATCH', `/articles/${ids.sick}`, { title: '' })).status, 400);
  assert.equal((await call('emp', 'PATCH', `/articles/${ids.sick}`, { title: 'x' })).status, 403);
  assert.equal((await call('hr', 'PATCH', `/categories/${other}`, { title: 'Pay' })).status, 200);
  const cats = (await call('hr', 'GET', '/')).json.categories;
  assert.equal(cats.find((c) => c.id === other).title, 'Pay');
  const reorder = await call('hr', 'PUT', '/order', { ids: [other, ids.leave] });
  assert.equal(reorder.status, 200, JSON.stringify(reorder.json));
  assert.deepEqual((await call('emp', 'GET', '/')).json.categories.map((c) => c.title), ['Pay', 'Leave']);
  assert.equal((await call('hr', 'DELETE', `/articles/${ids.sick}`)).status, 200);
  assert.equal((await call('hr', 'DELETE', `/articles/${ids.sick}`)).status, 404);
  assert.equal((await call('emp', 'GET', '/articles/abc')).status, 400);
});

test('the editor can preview what an article will look like: the same sections the reading view gets (managers only)', async (t) => {
  if (skip(t)) return;
  const text = ['# Title', '', 'A paragraph.', '', '- one', '- two'].join(String.fromCharCode(10));
  assert.equal((await call('emp', 'POST', '/preview', { body: text })).status, 403);
  const preview = await call('hr', 'POST', '/preview', { body: text });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(preview.json.sections.map((section) => section.type), ['heading', 'paragraph', 'list']);
  assert.deepEqual((await call('hr', 'POST', '/preview', { body: '' })).json.sections, []);
  assert.equal((await call('hr', 'POST', '/preview', { body: 'x'.repeat(100001) })).status, 400);
});
