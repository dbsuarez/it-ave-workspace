// Cover photos: each person sets their own (never anyone else's), everyone who may see the profile sees it, and the version travels with the profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config; let uploads;
const ids = {};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'cover-secret';
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-'));
  process.env.UPLOAD_DIR = uploads;
  config = require('../src/config');
  config.UPLOAD_DIR = uploads;
  pool = require('../src/db').pool;
  const add = async (name, type = 'member') => (await admin.query("INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, 'x', $3) RETURNING id", [name, `${name}@x.test`, type])).rows[0].id;
  ids.ann = await add('cov-ann');
  ids.ben = await add('cov-ben');
  ids.guest = await add('cov-guest', 'guest');
  const app = express();
  app.use('/api/users', require('../src/routes/users'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
  if (uploads) fs.rmSync(uploads, { recursive: true, force: true });
});

const auth = (who) => ({ Authorization: `Bearer ${jwt.sign({ userId: ids[who], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}` });
const upload = async (who, bytes = PNG, name = 'cover.png') => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const res = await fetch(`${baseUrl}/api/users/me/cover`, { method: 'PUT', headers: auth(who), body: form });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('a person sets their own cover, and everyone who can see them can fetch it', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const put = await upload('ann');
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.ok(Number.isFinite(put.json.coverVersion));
  const got = await fetch(`${baseUrl}/api/users/${ids.ann}/cover`, { headers: auth('ben') });
  assert.equal(got.status, 200);
  assert.match(got.headers.get('content-type'), /image\/png/);
  assert.equal(Buffer.from(await got.arrayBuffer()).equals(PNG), true);
  const again = await fetch(`${baseUrl}/api/users/${ids.ann}/cover`, { headers: { ...auth('ben'), 'If-None-Match': got.headers.get('etag') } });
  assert.equal(again.status, 304, 'cached by version');
  assert.equal((await fetch(`${baseUrl}/api/users/${ids.ben}/cover`, { headers: auth('ann') })).status, 404, 'no cover set');
});

test('there is no way to set someone else\'s cover: the route only ever writes to the signed-in person', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  await upload('ben');
  const row = (a) => admin.query('SELECT cover_file FROM users WHERE id = $1', [ids[a]]).then((r) => r.rows[0].cover_file);
  assert.ok(await row('ann') && await row('ben') && (await row('ann')) !== (await row('ben')));
  const form = new FormData();
  form.append('file', new Blob([PNG]), 'cover.png');
  form.append('userId', String(ids.ann));
  await fetch(`${baseUrl}/api/users/me/cover?userId=${ids.ann}`, { method: 'PUT', headers: auth('ben'), body: form });
  assert.equal((await fetch(`${baseUrl}/api/users/${ids.ann}/cover`, { method: 'PUT', headers: auth('ben'), body: form })).status === 200, false, 'no route to set another person\'s cover');
});

test('a guest sees only the covers of people they share a channel with', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  assert.equal((await fetch(`${baseUrl}/api/users/${ids.ann}/cover`, { headers: auth('guest') })).status, 404);
});

test('only pictures are accepted, within the size limit, and replacing or removing deletes the old file', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  assert.equal((await upload('ann', Buffer.from('<svg onload=x>'), 'cover.svg')).status, 400);
  assert.equal((await upload('ann', Buffer.from('not a picture at all'), 'cover.png')).status, 400, 'a file that is not really a picture');
  assert.equal((await upload('ann', Buffer.alloc(3 * 1024 * 1024 + 10, 1), 'cover.png')).status, 400, 'too big');
  const before = (await admin.query('SELECT cover_file FROM users WHERE id = $1', [ids.ann])).rows[0].cover_file;
  assert.ok(fs.existsSync(path.join(uploads, before)));
  assert.equal((await upload('ann')).status, 200);
  assert.equal(fs.existsSync(path.join(uploads, before)), false, 'the replaced file is gone');
  const current = (await admin.query('SELECT cover_file FROM users WHERE id = $1', [ids.ann])).rows[0].cover_file;
  const del = await fetch(`${baseUrl}/api/users/me/cover`, { method: 'DELETE', headers: auth('ann') });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).coverVersion, null);
  assert.equal(fs.existsSync(path.join(uploads, current)), false);
  assert.equal((await fetch(`${baseUrl}/api/users/${ids.ann}/cover`, { headers: auth('ben') })).status, 404);
});

test('the profile card carries the cover version, so the card can show it', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  assert.equal((await fetch(`${baseUrl}/api/users/${ids.ann}/card`, { headers: auth('ben') }).then((r) => r.json())).card.coverVersion, null);
  const put = await upload('ann');
  const card = (await fetch(`${baseUrl}/api/users/${ids.ann}/card`, { headers: auth('ben') }).then((r) => r.json())).card;
  assert.equal(card.coverVersion, put.json.coverVersion);
});
