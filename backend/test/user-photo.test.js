// Profile photos against a real PostgreSQL (scratch database). Skipped when none is reachable.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch;
let admin;
let server;
let baseUrl;
let pool;
let config;
let uploadDir;
const ids = {};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(40)]);

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-photo-'));
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'user-photo-secret';
  process.env.UPLOAD_DIR = uploadDir;
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, type = 'member') => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', type]
  )).rows[0].id;
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  ids.guest = await user('visitor', 'guest');
  ids.team = (await admin.query("INSERT INTO channels (name, created_by) VALUES ('team', $1) RETURNING id", [ids.ann])).rows[0].id;
  for (const id of [ids.ann, ids.guest]) await admin.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'member')", [ids.team, id]);
  const app = express();
  app.use(express.json());
  app.use('/api/users', require('../src/routes/users'));
  app.use('/api/auth', require('../src/routes/auth'));
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

const token = (userId) => jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET);
const put = async (userId, name, bytes) => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const res = await fetch(`${baseUrl}/api/users/me/photo`, { method: 'PUT', headers: { Authorization: `Bearer ${token(userId)}` }, body: form });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const get = (userId, targetId, headers = {}) => fetch(`${baseUrl}/api/users/${targetId}/photo`, { headers: { Authorization: `Bearer ${token(userId)}`, ...headers } });
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const stored = () => fs.readdirSync(uploadDir).filter((f) => f.startsWith('avatar-'));

test('a person can set a photo, and others who may see them can fetch it', async (t) => {
  if (skip(t)) return;
  const up = await put(ids.ann, 'me.png', PNG);
  assert.equal(up.status, 200);
  assert.ok(up.json.photoVersion > 0);
  const own = await get(ids.ann, ids.ann);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/png');
  assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), PNG);
  assert.equal((await get(ids.bob, ids.ann)).status, 200, 'a colleague can see it');
  assert.equal((await get(ids.guest, ids.ann)).status, 200, 'a guest sees people they share a channel with');
  assert.equal((await get(ids.ann, ids.bob)).status, 404, 'no photo set');
});

test('a guest cannot fetch photos of people they share no channel with', async (t) => {
  if (skip(t)) return;
  await put(ids.bob, 'bob.png', PNG);
  assert.equal((await get(ids.guest, ids.bob)).status, 404);
  assert.equal((await get(ids.ann, ids.bob)).status, 200);
});

test('the photo list data reports who has one, and a cached copy is revalidated', async (t) => {
  if (skip(t)) return;
  await put(ids.ann, 'me.png', PNG);
  const list = await (await fetch(`${baseUrl}/api/users`, { headers: { Authorization: `Bearer ${token(ids.bob)}` } })).json();
  const ann = list.users.find((u) => u.id === ids.ann);
  assert.ok(ann.photoVersion > 0);
  const nobody = list.users.find((u) => u.id === ids.guest);
  assert.equal(nobody.photoVersion, null);
  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token(ids.ann)}` } })).json();
  assert.equal(me.user.photoVersion, ann.photoVersion);
  const first = await get(ids.bob, ids.ann);
  const again = await get(ids.bob, ids.ann, { 'If-None-Match': first.headers.get('etag') });
  assert.equal(again.status, 304);
});

test('replacing a photo removes the old file; removing it clears everything', async (t) => {
  if (skip(t)) return;
  await put(ids.ann, 'a.png', PNG);
  const before = stored().filter((f) => f.startsWith(`avatar-${ids.ann}-`));
  assert.equal(before.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await put(ids.ann, 'b.jpg', JPEG);
  assert.equal(second.status, 200);
  const afterReplace = stored().filter((f) => f.startsWith(`avatar-${ids.ann}-`));
  assert.equal(afterReplace.length, 1, 'only the new file is kept');
  assert.notEqual(afterReplace[0], before[0]);
  assert.equal((await get(ids.bob, ids.ann)).headers.get('content-type'), 'image/jpeg');
  const del = await fetch(`${baseUrl}/api/users/me/photo`, { method: 'DELETE', headers: { Authorization: `Bearer ${token(ids.ann)}` } });
  assert.equal((await del.json()).photoVersion, null);
  assert.equal((await get(ids.bob, ids.ann)).status, 404);
  assert.equal(stored().filter((f) => f.startsWith(`avatar-${ids.ann}-`)).length, 0, 'the file is gone');
});

test('only real PNG or JPEG pictures of a sensible size are accepted', async (t) => {
  if (skip(t)) return;
  const filesBefore = stored().length;
  assert.equal((await put(ids.bob, 'x.svg', Buffer.from('<svg/>'))).status, 400);
  assert.equal((await put(ids.bob, 'x.gif', Buffer.from('GIF89a'))).status, 400);
  assert.equal((await put(ids.bob, 'x.exe', Buffer.from('MZ...'))).status, 400);
  assert.equal((await put(ids.bob, 'fake.png', Buffer.from('this is text'))).status, 400, 'contents must match the extension');
  const huge = await put(ids.bob, 'big.png', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 10)]));
  assert.equal(huge.status, 400);
  assert.match(huge.json.error, /2MB/);
  assert.equal(stored().length, filesBefore, 'rejected uploads leave nothing behind');
  assert.equal((await get(ids.ann, 'abc')).status, 400);
});
