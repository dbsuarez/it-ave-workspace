// Knowledge Base backup and restore API: only people who manage the Knowledge Base, choose what goes in, restore only what is chosen.
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
  process.env.JWT_SECRET = 'kbb-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const add = async (name, owner = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name, `${name}@x.test`, 'x', 'member', owner])).rows[0].id;
  ids.hr = await add('kbb-hr');
  ids.emp = await add('kbb-emp');
  await admin.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE legacy_hr = true', [ids.hr]);
  const app = express();
  app.use('/api/kb-backup', require('../src/routes/knowledgeBaseBackup'));
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

const call = async (user, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/kb-backup${path}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[user], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json = {};
  try { json = JSON.parse(bytes.toString('utf8')); } catch { /* a zip */ }
  return { status: res.status, json, bytes, disposition: res.headers.get('content-disposition'), type: res.headers.get('content-type') };
};
// the backup file goes up as a file with the choices next to it
const upload = async (user, path, zip, choice) => {
  const form = new FormData();
  form.append('file', new Blob([zip]), 'kb.zip');
  if (choice) form.append('choice', JSON.stringify(choice));
  const res = await fetch(`${baseUrl}/api/kb-backup${path}`, { method: 'POST', headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[user], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}` }, body: form });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('backup, check and restore: HR only, chosen articles only, an existing article is left alone unless told otherwise', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  for (const [method, path] of [['GET', '/outline'], ['POST', '/export'], ['POST', '/preview'], ['POST', '/restore']]) {
    assert.equal((await call('emp', method, path, {})).status, 403, `${path} is for managers`);
  }
  const cat = (await admin.query("INSERT INTO kb_categories (title, position) VALUES ('Leave', 1) RETURNING id")).rows[0].id;
  const make = async (title, text) => {
    const canvas = (await admin.query("INSERT INTO canvases (kind, title, content, created_by, owner_id) VALUES ('standalone', $1, $2, $3, $3) RETURNING id", [title, text, ids.hr])).rows[0].id;
    return (await admin.query("INSERT INTO kb_articles (category_id, title, body, published, position, created_by, canvas_id) VALUES ($1, $2, '', true, 1, $3, $4) RETURNING id", [cat, title, ids.hr, canvas])).rows[0].id;
  };
  const first = await make('How to file', 'step one');
  await make('Sick leave', 'certificate');

  const outline = await call('hr', 'GET', '/outline');
  assert.deepEqual(outline.json.categories.map((c) => [c.title, c.articles.map((a) => a.title)]), [['Leave', ['How to file', 'Sick leave']]]);

  const exported = await call('hr', 'POST', '/export', { articleIds: [first], parts: {} });
  assert.equal(exported.status, 200);
  assert.match(exported.disposition, /attachment; filename="knowledge-base-\d{4}-\d{2}-\d{2}\.zip"/);
  assert.equal(exported.type, 'application/zip');
  const zip = exported.bytes;
  const pkg = require('../src/knowledgeBasePackage').validatePackage(require('../src/knowledgeBasePackage').readPackageFile(zip));
  assert.deepEqual(pkg.categories[0].articles.map((a) => a.title), ['How to file']);

  assert.equal((await upload('hr', '/preview', Buffer.from('nope'))).status, 400);
  assert.equal((await upload('emp', '/preview', zip)).status, 403);
  const preview = await upload('hr', '/preview', zip);
  assert.equal(preview.json.categories[0].articles[0].exists, true);

  await admin.query("UPDATE canvases SET content = 'edited since' WHERE title = 'How to file'");
  assert.equal((await upload('hr', '/restore', zip, {})).status, 400, 'the articles to restore must be chosen');
  const key = pkg.categories[0].articles[0].key;
  const skipped = await upload('hr', '/restore', zip, { articles: [{ key, action: 'skip' }] });
  assert.deepEqual([skipped.json.skipped, skipped.json.replaced], [1, 0]);
  assert.equal((await admin.query("SELECT content FROM canvases WHERE title = 'How to file'")).rows[0].content, 'edited since');
  const replaced = await upload('hr', '/restore', zip, { articles: [{ key, action: 'replace' }] });
  assert.equal(replaced.json.replaced, 1);
  assert.equal((await admin.query("SELECT content FROM canvases WHERE title = 'How to file'")).rows[0].content, 'step one');
});
