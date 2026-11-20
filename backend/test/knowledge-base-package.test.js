// Knowledge Base package: export (choose what goes in), check a file, restore (all or chosen articles), and survive a workspace reset.
// Runs against a real PostgreSQL (scratch database).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let pool; let config; let pkgLib; let uploads;
const ids = {};
// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function addArticle(categoryId, title, text, { published = true, screens = [], withPicture = false } = {}) {
  const canvas = (await admin.query("INSERT INTO canvases (kind, title, content, created_by, owner_id) VALUES ('standalone', $1, $2, $3, $3) RETURNING id", [title, text, ids.hr])).rows[0].id;
  const article = (await admin.query(
    `INSERT INTO kb_articles (category_id, title, body, published, published_at, position, created_by, updated_by, canvas_id)
     VALUES ($1, $2, '', $3, CASE WHEN $3 THEN NOW() END, COALESCE((SELECT MAX(position) + 1 FROM kb_articles WHERE category_id = $1), 1), $4, $4, $5) RETURNING id`,
    [categoryId, title, published, ids.hr, canvas])).rows[0].id;
  for (const key of screens) await admin.query('INSERT INTO kb_article_screens (article_id, screen_key) VALUES ($1, $2)', [article, key]);
  let fileId = null;
  if (withPicture) {
    const filename = `kbpkg-${article}.png`;
    fs.writeFileSync(path.join(uploads, filename), PNG);
    fileId = (await admin.query('INSERT INTO files (canvas_id, filename, original_name, size, mime_type, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [canvas, filename, 'logo.png', PNG.length, 'image/png', ids.hr])).rows[0].id;
    await admin.query('UPDATE canvases SET content = $2 WHERE id = $1', [canvas, `${text}\n\n![logo](file:${fileId})\n`]);
  }
  return { article, canvas, fileId };
}

async function wipeKnowledgeBase() {
  await admin.query('DELETE FROM kb_articles');
  await admin.query("DELETE FROM canvases WHERE kind = 'standalone'");
  await admin.query('DELETE FROM kb_categories');
}

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'kbpkg-'));
  process.env.UPLOAD_DIR = uploads;
  config = require('../src/config');
  config.UPLOAD_DIR = uploads;
  config.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kbpkg-backups-'));
  pool = require('../src/db').pool;
  pkgLib = require('../src/knowledgeBasePackage');
  ids.hr = (await admin.query("INSERT INTO users (username, email, password_hash, first_name, last_name) VALUES ('pkg-hr', 'pkg-hr@x.test', 'x', 'Hana', 'Reyes') RETURNING id")).rows[0].id;
});

test.after(async () => {
  if (admin) await admin.end();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
  if (uploads) fs.rmSync(uploads, { recursive: true, force: true });
  if (config && config.BACKUP_DIR) fs.rmSync(config.BACKUP_DIR, { recursive: true, force: true });
});

async function seed() {
  await wipeKnowledgeBase();
  ids.catA = (await admin.query("INSERT INTO kb_categories (title, position) VALUES ('Leave', 1) RETURNING id")).rows[0].id;
  ids.catB = (await admin.query("INSERT INTO kb_categories (title, position) VALUES ('Payroll', 2) RETURNING id")).rows[0].id;
  ids.a1 = await addArticle(ids.catA, 'How do I file a leave?', 'Open **Leave** and press New.', { screens: ['leave'], withPicture: true });
  ids.a2 = await addArticle(ids.catA, 'Sick leave', 'Bring a certificate.', { published: false });
  ids.a3 = await addArticle(ids.catB, 'Pay dates', '15th and 30th.');
  await admin.query('INSERT INTO canvas_revisions (canvas_id, revision, title, content, edited_by) VALUES ($1, 1, $2, $3, $4)', [ids.a1.canvas, 'How do I file a leave?', 'older text', ids.hr]);
  const root = (await admin.query('INSERT INTO canvas_comments (canvas_id, user_id, body, anchor) VALUES ($1, $2, $3, $4) RETURNING id', [ids.a1.canvas, ids.hr, 'Please add the form link', 'press New'])).rows[0].id;
  await admin.query('INSERT INTO canvas_comments (canvas_id, parent_id, user_id, body) VALUES ($1, $2, $3, $4)', [ids.a1.canvas, root, ids.hr, 'Done']);
}

test('export includes what was chosen and nothing else', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  await seed();
  const all = await pkgLib.buildPackage(pool, { parts: { pictures: true, screens: true, history: true, comments: true } });
  assert.equal(all.format, 'itavenue-knowledge-base');
  assert.deepEqual(all.categories.map((c) => c.title), ['Leave', 'Payroll']);
  const leave = all.categories[0].articles.find((a) => a.title === 'How do I file a leave?');
  assert.match(leave.text, /Open \*\*Leave\*\*/);
  assert.deepEqual(leave.screens, ['leave']);
  assert.equal(leave.history.length, 1);
  assert.equal(leave.comments.length, 2);
  assert.equal(leave.comments[1].parent, leave.comments[0].key);
  assert.equal(Object.keys(all.pictures).length, 1);
  assert.equal(Buffer.from(Object.values(all.pictures)[0].data, 'base64').equals(PNG), true);
  assert.equal(all.categories[0].articles.find((a) => a.title === 'Sick leave').published, false);

  const bare = await pkgLib.buildPackage(pool, { parts: {} });
  const bareLeave = bare.categories[0].articles.find((a) => a.title === 'How do I file a leave?');
  assert.equal(bareLeave.screens, undefined);
  assert.equal(bareLeave.history, undefined);
  assert.equal(bareLeave.comments, undefined);
  assert.deepEqual(bare.pictures, {});

  const one = await pkgLib.buildPackage(pool, { selection: { articleIds: [ids.a3.article], categoryIds: [] }, parts: {} });
  assert.deepEqual(one.categories.map((c) => [c.title, c.articles.map((a) => a.title)]), [['Payroll', ['Pay dates']]]);
  const wholeCategory = await pkgLib.buildPackage(pool, { selection: { articleIds: [], categoryIds: [ids.catA] }, parts: {} });
  assert.equal(wholeCategory.categories[0].articles.length, 2);
});

test('a package file is checked before anything is read from it', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  assert.throws(() => pkgLib.validatePackage(null), /Knowledge Base backup/);
  assert.throws(() => pkgLib.validatePackage({ format: 'something-else', version: 1 }), /Knowledge Base backup/);
  assert.throws(() => pkgLib.validatePackage({ format: 'itavenue-knowledge-base', version: 99, categories: [] }), /newer|version/i);
  assert.throws(() => pkgLib.validatePackage({ format: 'itavenue-knowledge-base', version: 1, categories: [{ key: 'c1', title: '', articles: [] }] }), /title/);
  const evil = { format: 'itavenue-knowledge-base', version: 1, categories: [], pictures: { 1: { name: 'x.svg', mime: 'image/svg+xml', data: 'PHN2Zz4=' } } };
  assert.throws(() => pkgLib.validatePackage(evil), /picture/i);
  const clean = pkgLib.validatePackage({ format: 'itavenue-knowledge-base', version: 1, categories: [{ key: 'c1', title: ' Leave ', articles: [{ key: 'a1', title: ' T ', text: 'x', published: 1 }] }], extra: '<script>' });
  assert.equal(clean.categories[0].title, 'Leave');
  assert.equal(clean.categories[0].articles[0].title, 'T');
  assert.equal(clean.categories[0].articles[0].published, true);
  assert.equal(clean.extra, undefined);
});

test('describing a package says which articles already exist', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  await seed();
  const pkg = pkgLib.validatePackage(await pkgLib.buildPackage(pool, { parts: { pictures: true, screens: true, history: true, comments: true } }));
  const described = await pkgLib.describePackage(pool, pkg);
  const leave = described.categories.find((c) => c.title === 'Leave');
  assert.equal(leave.articles.every((a) => a.exists), true);
  await admin.query('DELETE FROM kb_articles WHERE id = $1', [ids.a3.article]);
  const again = await pkgLib.describePackage(pool, pkg);
  assert.equal(again.categories.find((c) => c.title === 'Payroll').articles[0].exists, false);
  assert.deepEqual(again.parts, { pictures: true, screens: true, history: true, comments: true });
});

test('restore brings back articles with pictures, history, comments and Help links, all linked to the new records', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  await seed();
  const pkg = pkgLib.validatePackage(await pkgLib.buildPackage(pool, { parts: { pictures: true, screens: true, history: true, comments: true } }));
  await wipeKnowledgeBase();
  for (const name of fs.readdirSync(uploads)) fs.rmSync(path.join(uploads, name));
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await pkgLib.restorePackage(client, pkg, { userId: ids.hr });
    await client.query('COMMIT');
  } finally { client.release(); }
  assert.equal(result.created, 3);
  const row = (await admin.query(`SELECT a.id, a.published, a.canvas_id, c.content, cat.title AS category FROM kb_articles a JOIN canvases c ON c.id = a.canvas_id JOIN kb_categories cat ON cat.id = a.category_id WHERE a.title = 'How do I file a leave?'`)).rows[0];
  assert.equal(row.category, 'Leave');
  assert.equal(row.published, true);
  const picture = (await admin.query('SELECT id, filename, mime_type FROM files WHERE canvas_id = $1', [row.canvas_id])).rows[0];
  assert.match(row.content, new RegExp(`!\\[logo\\]\\(file:${picture.id}\\)`));
  assert.equal(fs.readFileSync(path.join(uploads, picture.filename)).equals(PNG), true);
  assert.equal(picture.mime_type, 'image/png');
  assert.deepEqual((await admin.query('SELECT screen_key FROM kb_article_screens WHERE article_id = $1', [row.id])).rows.map((r) => r.screen_key), ['leave']);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM canvas_revisions WHERE canvas_id = $1', [row.canvas_id])).rows[0].n >= 1, true);
  const comments = (await admin.query('SELECT id, parent_id, body FROM canvas_comments WHERE canvas_id = $1 ORDER BY id', [row.canvas_id])).rows;
  assert.deepEqual(comments.map((c) => c.body), ['Please add the form link', 'Done']);
  assert.equal(comments[1].parent_id, comments[0].id);
  assert.equal((await admin.query("SELECT published FROM kb_articles WHERE title = 'Sick leave'")).rows[0].published, false);
});

test('restore can take only the chosen articles, and says what to do when one already exists', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  await seed();
  const pkg = pkgLib.validatePackage(await pkgLib.buildPackage(pool, { parts: { pictures: true, history: true } }));
  const keys = Object.fromEntries(pkg.categories.flatMap((c) => c.articles.map((a) => [a.title, a.key])));
  await admin.query("UPDATE canvases SET content = 'CHANGED LATER' WHERE id = $1", [ids.a3.canvas]);
  await admin.query("UPDATE canvases SET content = 'CHANGED TOO' WHERE id = $1", [ids.a2.canvas]);
  const run = async (options) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await pkgLib.restorePackage(client, pkg, { userId: ids.hr, ...options }); await client.query('COMMIT'); return out; } finally { client.release(); }
  };
  // only two articles chosen: one skipped (default), one replaced
  const out = await run({ articles: [{ key: keys['Pay dates'], action: 'skip' }, { key: keys['Sick leave'], action: 'replace' }] });
  assert.deepEqual([out.skipped, out.replaced, out.created, out.copied], [1, 1, 0, 0]);
  assert.equal((await admin.query('SELECT content FROM canvases WHERE id = $1', [ids.a3.canvas])).rows[0].content, 'CHANGED LATER', 'skipped: untouched');
  assert.equal((await admin.query('SELECT content FROM canvases WHERE id = $1', [ids.a2.canvas])).rows[0].content, 'Bring a certificate.', 'replaced: the backed-up text is back');
  const kept = (await admin.query('SELECT content FROM canvas_revisions WHERE canvas_id = $1 ORDER BY revision DESC LIMIT 1', [ids.a2.canvas])).rows[0];
  assert.equal(kept.content, 'CHANGED TOO', 'the text that was replaced stays in the history');
  assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM kb_articles WHERE title = 'How do I file a leave?'")).rows[0].n, 1, 'an article that was not chosen is not touched');
  // copy
  const copied = await run({ articles: [{ key: keys['Pay dates'], action: 'copy' }] });
  assert.equal(copied.copied, 1);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM kb_articles WHERE title = 'Pay dates (restored)'")).rows[0].n, 1);
  // nothing chosen restores nothing
  const none = await run({ articles: [] });
  assert.deepEqual([none.created, none.replaced, none.copied], [0, 0, 0]);
});

test('the Knowledge Base survives a workspace reset, with its pictures', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  await seed();
  const { clearDatabase, clearUploads, preserveKnowledgeBase } = require('../src/workspaceReset');
  const outcome = await preserveKnowledgeBase(pool, async () => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await clearDatabase(client); await client.query('COMMIT'); } finally { client.release(); }
    await clearUploads();
    assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM kb_articles')).rows[0].n, 0, 'the reset really did wipe it');
  }, ids.hr);
  assert.equal(outcome.restored, true, outcome.error);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM kb_articles')).rows[0].n, 3);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM kb_categories WHERE title IN ('Leave', 'Payroll')")).rows[0].n, 2);
  const canvas = (await admin.query("SELECT canvas_id FROM kb_articles WHERE title = 'How do I file a leave?'")).rows[0].canvas_id;
  const picture = (await admin.query('SELECT filename FROM files WHERE canvas_id = $1', [canvas])).rows[0];
  assert.equal(fs.readFileSync(path.join(uploads, picture.filename)).equals(PNG), true);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM canvas_comments WHERE canvas_id = $1', [canvas])).rows[0].n, 2);
  assert.ok(outcome.file && fs.existsSync(outcome.file), 'a copy of the package is kept next to the backups');
  fs.rmSync(outcome.file, { force: true });
});

test('a package is saved as a zip (text as JSON, pictures as real image files) and read back, and a JSON file still opens', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  await seed();
  const built = await pkgLib.buildPackage(pool, { parts: { pictures: true, screens: true, history: true, comments: true } });
  const zip = pkgLib.packToZip(built);
  assert.equal(zip.subarray(0, 2).toString(), 'PK', 'a zip file');
  const { unzipSync } = require('fflate');
  const entries = unzipSync(new Uint8Array(zip));
  const names = Object.keys(entries);
  assert.ok(names.includes('knowledge-base.json'));
  const picture = names.find((name) => name.startsWith('pictures/'));
  assert.ok(picture && /\.png$/.test(picture), 'the picture is its own file');
  assert.equal(Buffer.from(entries[picture]).equals(PNG), true);
  assert.equal(Buffer.byteLength(JSON.stringify(JSON.parse(Buffer.from(entries['knowledge-base.json']).toString()))) < JSON.stringify(built).length, true, 'the picture bytes are not repeated inside the JSON');

  const back = pkgLib.validatePackage(pkgLib.readPackageFile(zip));
  const original = pkgLib.validatePackage(built);
  assert.deepEqual(back, original);
  assert.deepEqual(pkgLib.validatePackage(pkgLib.readPackageFile(Buffer.from(JSON.stringify(built)))), original, 'a plain JSON backup opens too');
});

test('a bad or hostile zip is refused', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const { zipSync } = require('fflate');
  assert.throws(() => pkgLib.readPackageFile(Buffer.from('not a backup')), /Knowledge Base backup/);
  assert.throws(() => pkgLib.readPackageFile(Buffer.from('PK\u0003\u0004 broken')), /Knowledge Base backup/);
  const noJson = Buffer.from(zipSync({ 'readme.txt': new Uint8Array([65]) }));
  assert.throws(() => pkgLib.readPackageFile(noJson), /Knowledge Base backup/);
  const huge = Buffer.from(zipSync({ 'knowledge-base.json': new Uint8Array(1024), 'pictures/x.png': new Uint8Array(11 * 1024 * 1024) }));
  assert.throws(() => pkgLib.readPackageFile(huge), /Knowledge Base backup|bigger|too/);
  const odd = Buffer.from(zipSync({ 'knowledge-base.json': new TextEncoder().encode(JSON.stringify({ format: 'itavenue-knowledge-base', version: 1, categories: [], pictures: { 1: { name: 'a.png', mime: 'image/png', file: '../../etc/passwd' } } })) }));
  const read = pkgLib.validatePackage(pkgLib.readPackageFile(odd));
  assert.deepEqual(read.pictures, {}, 'a picture path that points outside the zip is ignored');
});
