// Knowledge Base articles are Canvases: HR edits them with the Canvas routes (text, pictures, history), employees read published ones,
// they stay out of personal Canvas lists, and cannot be deleted or shared from Canvas. Plus the Help links. Real PostgreSQL (scratch).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config; let uploadDir;
const ids = {};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-canvas-'));
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'kb-canvas-secret';
  process.env.UPLOAD_DIR = uploadDir;
  config = require('../src/config');
  pool = require('../src/db').pool;
  const add = async (name, first = '', last = '') => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, first_name, last_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [name, `${name}@x.test`, 'x', 'member', first, last])).rows[0].id;
  ids.hr = await add('kc-hr', 'Hana', 'Reyes');
  ids.hr2 = await add('kc-hr2', 'Rita', 'Cruz');
  ids.emp = await add('kc-emp');
  for (const user of [ids.hr, ids.hr2]) await admin.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE legacy_hr = true', [user]);
  const app = express();
  app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }) }; next(); });
  app.use('/api/kb', require('../src/routes/knowledgeBase'));
  app.use(express.json());
  app.use('/api/canvas', require('../src/routes/canvas'));
  app.use('/api/files', require('../src/routes/files'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
  if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true });
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const bearer = (user) => ({ Authorization: `Bearer ${jwt.sign({ userId: ids[user], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}` });
const call = async (user, method, p, body) => {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { ...bearer(user), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const kb = (user, method, p, body) => call(user, method, `/api/kb${p}`, body);
const upload = async (user, canvasId, name, bytes) => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const res = await fetch(`${baseUrl}/api/canvas/${canvasId}/images`, { method: 'POST', headers: bearer(user), body: form });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const download = (user, fileId) => fetch(`${baseUrl}/api/files/${fileId}/download`, { headers: bearer(user) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('an article is a canvas: HR edits it with the Canvas routes, and the article shows that text, when and by whom', async (t) => {
  if (skip(t)) return;
  ids.category = (await kb('hr', 'POST', '/categories', { title: 'Leave' })).json.category.id;
  const made = await kb('hr', 'POST', '/articles', { categoryId: ids.category, title: 'File a leave', body: 'First text.', published: false });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  ids.article = made.json.article.id;
  ids.canvas = made.json.article.canvasId;
  assert.ok(ids.canvas, 'managers are told which canvas holds the text, to open it in the Canvas editor');
  assert.equal((await kb('emp', 'GET', `/articles/${ids.article}`)).json.article?.canvasId, undefined, 'employees are not told');

  const opened = await call('hr2', 'GET', `/api/canvas/${ids.canvas}`);
  assert.equal(opened.status, 200, 'any HR person can open it, not just the one who made it');
  assert.equal(opened.json.canvas.content, 'First text.');
  await sleep(15);
  const saved = await call('hr2', 'PATCH', `/api/canvas/${ids.canvas}`, { content: '# Filing\n\nSecond text, written in the Canvas editor.', baseRevision: opened.json.canvas.revision });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const read = await kb('hr', 'GET', `/articles/${ids.article}`);
  assert.match(read.json.article.body, /Second text/);
  assert.equal(read.json.article.updatedByName, 'Rita Cruz', 'the last person who changed the text');
  assert.ok(read.json.sections.some((s) => s.type === 'heading'));

  const renamed = await call('hr2', 'PATCH', `/api/canvas/${ids.canvas}`, { title: 'How do I file a leave?', baseRevision: saved.json.canvas.revision });
  assert.equal(renamed.status, 200);
  assert.equal((await kb('hr', 'GET', `/articles/${ids.article}`)).json.article.title, 'How do I file a leave?', 'the title follows the canvas');
  await kb('hr', 'PATCH', `/articles/${ids.article}`, { title: 'Filing a leave' });
  assert.equal((await call('hr', 'GET', `/api/canvas/${ids.canvas}`)).json.canvas.title, 'Filing a leave', 'and the other way round');
});

test('employees can read the canvas of a published article only, never edit it, and it stays out of personal Canvas lists', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('emp', 'GET', `/api/canvas/${ids.canvas}`)).status, 404, 'a draft is for HR only');
  await kb('hr', 'PATCH', `/articles/${ids.article}`, { published: true });
  assert.equal((await call('emp', 'GET', `/api/canvas/${ids.canvas}`)).status, 200);
  const edit = await call('emp', 'PATCH', `/api/canvas/${ids.canvas}`, { content: 'hacked', baseRevision: 1 });
  assert.ok([403, 404].includes(edit.status), String(edit.status));
  assert.equal((await call('emp', 'POST', `/api/canvas/${ids.canvas}/comments`, { body: 'hi' })).status, 403, 'read only: not even comments');
  for (const user of ['hr', 'hr2', 'emp']) {
    const list = await call(user, 'GET', '/api/canvas/standalone');
    assert.equal(list.json.canvases.some((c) => c.id === ids.canvas), false, `${user}'s own Canvas list does not show Knowledge Base articles`);
  }
});

test('a Knowledge Base canvas cannot be deleted, shared or handed over from Canvas', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('hr', 'DELETE', `/api/canvas/${ids.canvas}`)).status, 400);
  assert.equal((await call('hr', 'POST', `/api/canvas/${ids.canvas}/collaborators`, { username: 'kc-emp', role: 'editor' })).status, 400);
  assert.equal((await call('hr', 'POST', `/api/canvas/${ids.canvas}/shares`, { role: 'viewer' })).status, 400);
  assert.equal((await call('hr', 'POST', `/api/canvas/${ids.canvas}/owner`, { username: 'kc-emp' })).status, 400);
  assert.equal((await call('hr', 'GET', `/api/canvas/${ids.canvas}`)).status, 200, 'and it is still there');
  const other = await call('hr', 'POST', '/api/canvas', { title: 'A personal canvas', content: '' });
  assert.equal((await call('hr', 'DELETE', `/api/canvas/${other.json.canvas.id}`)).status, 200, 'ordinary canvases are not affected');
});

test('pictures added in the Canvas editor show to employees only while the article is published, and go when the article does', async (t) => {
  if (skip(t)) return;
  const up = await upload('hr', ids.canvas, 'steps.png', PNG);
  assert.equal(up.status, 201, JSON.stringify(up.json));
  ids.picture = up.json.fileId;
  assert.equal((await download('emp', ids.picture)).status, 200, 'published: an employee sees it');
  await kb('hr', 'PATCH', `/articles/${ids.article}`, { published: false });
  assert.equal((await download('emp', ids.picture)).status, 404, 'a draft hides its pictures');
  assert.equal((await download('hr', ids.picture)).status, 200);
  const file = (await admin.query('SELECT filename FROM files WHERE id = $1', [ids.picture])).rows[0].filename;
  assert.ok(fs.existsSync(path.join(uploadDir, file)));
  assert.equal((await kb('hr', 'DELETE', `/articles/${ids.article}`)).status, 200);
  assert.equal((await admin.query('SELECT 1 FROM canvases WHERE id = $1', [ids.canvas])).rows.length, 0, 'the text goes with the article');
  assert.equal(fs.existsSync(path.join(uploadDir, file)), false, 'and its pictures leave the disk');
});

test('deleting a category removes its articles texts and pictures too', async (t) => {
  if (skip(t)) return;
  const article = await kb('hr', 'POST', '/articles', { categoryId: ids.category, title: 'Another', body: 'x', published: true });
  const up = await upload('hr', article.json.article.canvasId, 'x.png', PNG);
  const file = (await admin.query('SELECT filename FROM files WHERE id = $1', [up.json.fileId])).rows[0].filename;
  assert.equal((await kb('hr', 'DELETE', `/categories/${ids.category}`)).status, 200);
  assert.equal((await admin.query('SELECT 1 FROM canvases WHERE id = $1', [article.json.article.canvasId])).rows.length, 0);
  assert.equal(fs.existsSync(path.join(uploadDir, file)), false);
});

test('an article can be linked to the screens it helps with; employees get the published ones for a screen', async (t) => {
  if (skip(t)) return;
  const category = (await kb('hr', 'POST', '/categories', { title: 'Help' })).json.category.id;
  const article = (await kb('hr', 'POST', '/articles', { categoryId: category, title: 'File a leave', body: 'Steps.', published: true })).json.article.id;
  const home = await kb('hr', 'GET', '/');
  assert.ok(home.json.screenOptions.some((s) => s.key === 'leave' && s.label === 'Leave'), 'managers are told which screens there are');
  assert.equal((await kb('emp', 'GET', '/')).json.screenOptions, undefined);
  assert.equal((await kb('emp', 'PATCH', `/articles/${article}`, { screens: ['leave'] })).status, 403);
  assert.equal((await kb('hr', 'PATCH', `/articles/${article}`, { screens: ['leave', 'nowhere'] })).status, 400, 'an unknown screen');
  const linked = await kb('hr', 'PATCH', `/articles/${article}`, { screens: ['leave', 'attendance'] });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  assert.deepEqual(linked.json.article.screens.sort(), ['attendance', 'leave']);
  const draft = await kb('hr', 'POST', '/articles', { categoryId: category, title: 'A draft about leave', body: '', screens: ['leave'] });
  assert.deepEqual(draft.json.article.screens, ['leave']);
  const forLeave = await kb('emp', 'GET', '/screens/leave');
  assert.equal(forLeave.status, 200);
  assert.deepEqual(forLeave.json.articles.map((a) => a.title), ['File a leave'], 'only published, only the linked ones');
  assert.deepEqual((await kb('emp', 'GET', '/screens/sheets')).json.articles, []);
  assert.equal((await kb('emp', 'GET', '/screens/nowhere')).status, 400);
  await kb('hr', 'PATCH', `/articles/${article}`, { screens: [] });
  assert.deepEqual((await kb('emp', 'GET', '/screens/leave')).json.articles, [], 'unlinked');
});
