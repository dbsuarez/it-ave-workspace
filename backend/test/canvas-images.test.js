// Images inside a canvas, against a real PostgreSQL (scratch database). Skipped when none is reachable.
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

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-images-'));
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'canvas-images-secret';
  process.env.UPLOAD_DIR = uploadDir;
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, type = 'member') => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', type]
  )).rows[0].id;
  ids.alice = await user('alice');
  ids.bob = await user('bob');
  ids.eve = await user('eve');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }) }; next(); });
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

const token = (userId) => jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET);
const json = async (userId, method, p, body) => {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token(userId)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const upload = async (userId, canvasId, name, bytes) => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const res = await fetch(`${baseUrl}/api/canvas/${canvasId}/images`, { method: 'POST', headers: { Authorization: `Bearer ${token(userId)}` }, body: form });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const download = (userId, fileId) => fetch(`${baseUrl}/api/files/${fileId}/download`, { headers: { Authorization: `Bearer ${token(userId)}` } });
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

async function newCanvas() {
  const { json: made } = await json(ids.alice, 'POST', '/api/canvas', { title: 'Pics', content: '' });
  return made.canvas.id;
}

test('an editor can add an image, and a reader of the canvas can fetch it', async (t) => {
  if (skip(t)) return;
  const canvasId = await newCanvas();
  await json(ids.alice, 'POST', `/api/canvas/${canvasId}/collaborators`, { username: 'bob', role: 'viewer' });
  const up = await upload(ids.alice, canvasId, 'logo.png', PNG);
  assert.equal(up.status, 201);
  assert.equal(up.json.mimeType, 'image/png');
  const own = await download(ids.alice, up.json.fileId);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), PNG);
  assert.equal((await download(ids.bob, up.json.fileId)).status, 200, 'a viewer can see it');
  assert.equal((await download(ids.eve, up.json.fileId)).status, 404, 'a stranger cannot');
});

test('viewers and strangers cannot upload', async (t) => {
  if (skip(t)) return;
  const canvasId = await newCanvas();
  await json(ids.alice, 'POST', `/api/canvas/${canvasId}/collaborators`, { username: 'bob', role: 'viewer' });
  assert.equal((await upload(ids.bob, canvasId, 'a.png', PNG)).status, 403);
  assert.equal((await upload(ids.eve, canvasId, 'a.png', PNG)).status, 404);
});

test('only real pictures are accepted', async (t) => {
  if (skip(t)) return;
  const canvasId = await newCanvas();
  assert.equal((await upload(ids.alice, canvasId, 'x.svg', Buffer.from('<svg/>'))).status, 400, 'svg is refused');
  assert.equal((await upload(ids.alice, canvasId, 'x.pdf', Buffer.from('%PDF-1'))).status, 400, 'not an image type');
  assert.equal((await upload(ids.alice, canvasId, 'x.exe', Buffer.from('MZ....'))).status, 400);
  const fake = await upload(ids.alice, canvasId, 'fake.png', Buffer.from('this is text, not a png'));
  assert.equal(fake.status, 400, 'contents must match the extension');
  const count = await admin.query('SELECT COUNT(*) AS n FROM files WHERE canvas_id = $1', [canvasId]);
  assert.equal(Number(count.rows[0].n), 0, 'nothing was stored');
  assert.equal(fs.readdirSync(uploadDir).filter((f) => f.includes('fake')).length, 0, 'the rejected file is removed from disk');
});

test('deleting the canvas deletes its images, rows and files', async (t) => {
  if (skip(t)) return;
  const canvasId = await newCanvas();
  const up = await upload(ids.alice, canvasId, 'gone.png', PNG);
  assert.equal(up.status, 201);
  assert.ok(fs.readdirSync(uploadDir).some((f) => f.includes('gone.png')));
  assert.equal((await json(ids.alice, 'DELETE', `/api/canvas/${canvasId}`)).status, 200);
  const rows = await admin.query('SELECT COUNT(*) AS n FROM files WHERE id = $1', [up.json.fileId]);
  assert.equal(Number(rows.rows[0].n), 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!fs.readdirSync(uploadDir).some((f) => f.includes('gone.png')), 'the stored file is gone');
});

test('a canvas holds at most 50 images', async (t) => {
  if (skip(t)) return;
  const canvasId = await newCanvas();
  for (let i = 0; i < 50; i += 1) {
    await admin.query(
      "INSERT INTO files (canvas_id, filename, original_name, size, mime_type, uploaded_by) VALUES ($1, $2, 'p.png', 1, 'image/png', $3)",
      [canvasId, `bulk-${i}.png`, ids.alice]
    );
  }
  const over = await upload(ids.alice, canvasId, 'one-more.png', PNG);
  assert.equal(over.status, 400);
  assert.match(over.json.error, /at most 50/);
});
