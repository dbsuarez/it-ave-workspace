// Removing a channel, and the workspace slow-mode policy, against a real PostgreSQL (scratch database).
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
let uploads;
const ids = {};
const emitted = [];

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'iav-channel-uploads-'));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'moderation-channels-secret';
  process.env.UPLOAD_DIR = uploads;
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, superadmin = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', superadmin]
  )).rows[0].id;
  ids.boss = await user('boss', true);
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
    next();
  });
  app.use('/api/moderation', require('../src/routes/moderation'));
  app.use('/api/channels', require('../src/routes/channels'));
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

const call = async (userId, method, path2, body) => {
  const res = await fetch(`${baseUrl}/api${path2}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

test('a new channel starts at 5 seconds of slow mode, or whatever the Superadmin set', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'GET', '/moderation/slowmode-policy')).status, 403);
  assert.deepEqual((await call(ids.boss, 'GET', '/moderation/slowmode-policy')).json, { defaultSeconds: 5 });
  const made = await call(ids.ann, 'POST', '/channels', { name: 'first-one' });
  assert.equal(made.status, 201);
  const row = (await admin.query('SELECT slowmode_seconds FROM channels WHERE id = $1', [made.json.channel.id])).rows[0];
  assert.equal(row.slowmode_seconds, 5);

  assert.equal((await call(ids.boss, 'PUT', '/moderation/slowmode-policy', { defaultSeconds: -1 })).status, 400);
  assert.equal((await call(ids.boss, 'PUT', '/moderation/slowmode-policy', { defaultSeconds: 'soon' })).status, 400);
  assert.equal((await call(ids.ann, 'PUT', '/moderation/slowmode-policy', { defaultSeconds: 0 })).status, 403);
  assert.equal((await call(ids.boss, 'PUT', '/moderation/slowmode-policy', { defaultSeconds: 0 })).json.defaultSeconds, 0);
  const off = await call(ids.ann, 'POST', '/channels', { name: 'second-one' });
  assert.equal((await admin.query('SELECT slowmode_seconds FROM channels WHERE id = $1', [off.json.channel.id])).rows[0].slowmode_seconds, 0, 'the new default applies');
  await call(ids.boss, 'PUT', '/moderation/slowmode-policy', { defaultSeconds: 5 });
});

test('the Superadmin sets one slow mode on every existing channel', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'POST', '/moderation/slowmode-all', { seconds: 9 })).status, 403);
  assert.equal((await call(ids.boss, 'POST', '/moderation/slowmode-all', { seconds: 99999 })).status, 400);
  const all = await call(ids.boss, 'POST', '/moderation/slowmode-all', { seconds: 9 });
  assert.equal(all.status, 200);
  const total = (await admin.query('SELECT COUNT(*)::int AS n FROM channels')).rows[0].n;
  assert.equal(all.json.channels, total);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM channels WHERE slowmode_seconds <> 9')).rows[0].n, 0, 'every channel has it');
  const log = (await admin.query("SELECT details FROM moderation_audit_log WHERE action = 'slowmode_set_for_all_channels'")).rows;
  assert.equal(log.length, 1);
});

test('deleting a channel: the creator or the Superadmin, with everything in it, and everyone is told', async (t) => {
  if (skip(t)) return;
  const made = await call(ids.ann, 'POST', '/channels', { name: 'to-delete' });
  const id = made.json.channel.id;
  await admin.query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, ids.bob]);
  const msg = (await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'hello') RETURNING id", [id, ids.ann])).rows[0].id;
  fs.writeFileSync(path.join(uploads, 'stored-file.bin'), 'x');
  await admin.query("INSERT INTO files (message_id, filename, original_name, size, mime_type, uploaded_by) VALUES ($1, 'stored-file.bin', 'a.bin', 1, 'application/octet-stream', $2)", [msg, ids.ann]);
  fs.writeFileSync(path.join(uploads, 'kept-file.bin'), 'x');

  assert.equal((await call(ids.bob, 'DELETE', `/moderation/channels/${id}`)).status, 403, 'a member who did not create it cannot');
  assert.equal((await call(ids.ann, 'DELETE', '/moderation/channels/99999')).status, 404);
  emitted.length = 0;
  const gone = await call(ids.ann, 'DELETE', `/moderation/channels/${id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.json.filesRemoved, 1);
  assert.equal((await admin.query('SELECT 1 FROM channels WHERE id = $1', [id])).rows.length, 0);
  assert.equal((await admin.query('SELECT 1 FROM messages WHERE channel_id = $1', [id])).rows.length, 0, 'its messages are gone');
  assert.equal((await admin.query('SELECT 1 FROM files WHERE message_id = $1', [msg])).rows.length, 0, 'and its file records');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(path.join(uploads, 'stored-file.bin')), false, 'the stored file is removed from disk');
  assert.equal(fs.existsSync(path.join(uploads, 'kept-file.bin')), true, 'other files are untouched');
  const told = emitted.filter((e) => e.event === 'channel_deleted').map((e) => e.room);
  assert.ok(told.includes(`user_${ids.ann}`) && told.includes(`user_${ids.bob}`), 'members are told');
  const log = (await admin.query("SELECT details, channel_id FROM moderation_audit_log WHERE action = 'channel_deleted'")).rows;
  assert.equal(log.length, 1, 'the audit log keeps the record');
  assert.equal(log[0].details.name, 'to-delete');

  const mine = await call(ids.bob, 'POST', '/channels', { name: 'bobs-room' });
  assert.equal((await call(ids.boss, 'DELETE', `/moderation/channels/${mine.json.channel.id}`)).status, 200, 'the Superadmin can delete any channel');
});
