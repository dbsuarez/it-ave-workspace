// A canvas shared into a channel shows in that channel's Canvases list (real PostgreSQL, scratch database).
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
  process.env.JWT_SECRET = 'canvases-shared-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name) => (await admin.query("INSERT INTO users (username, email, password_hash, first_name, last_name, avatar_color, photo_updated_at) VALUES ($1, $2, $3, 'Canvas', 'Owner', '#123456', NOW()) RETURNING id", [name, `${name}@x.test`, 'x'])).rows[0].id;
  ids.owner = await user('cowner');
  ids.member = await user('cmember');
  ids.channel = (await admin.query("INSERT INTO channels (name) VALUES ('shared-room') RETURNING id")).rows[0].id;
  ids.other = (await admin.query("INSERT INTO channels (name) VALUES ('other-room') RETURNING id")).rows[0].id;
  for (const id of [ids.owner, ids.member]) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.channel, id]);
  ids.canvas = (await admin.query("INSERT INTO canvases (kind, title, content, created_by, owner_id) VALUES ('standalone', 'Shared plan', 'x', $1, $1) RETURNING id", [ids.owner])).rows[0].id;
  ids.deleted = (await admin.query("INSERT INTO canvases (kind, title, content, created_by, owner_id, deleted_at) VALUES ('standalone', 'Deleted one', 'x', $1, $1, NOW()) RETURNING id", [ids.owner])).rows[0].id;
  await admin.query("INSERT INTO canvas_channel_grants (canvas_id, channel_id, role, granted_by) VALUES ($1, $2, 'viewer', $3), ($4, $2, 'viewer', $3), ($1, $5, 'viewer', $3)", [ids.canvas, ids.channel, ids.owner, ids.deleted, ids.other]);
  const app = express();
  app.use(express.json());
  app.use('/api/canvases', require('../src/routes/canvases'));
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

test('the channel\'s Canvases list includes canvases shared into it, not deleted ones, and only for members', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const get = async (userId, channelId) => {
    const token = jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET);
    const res = await fetch(`${baseUrl}/api/canvases?channelId=${channelId}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, json: await res.json() };
  };
  const mine = await get(ids.member, ids.channel);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.canvases.map((c) => [c.title, c.shared === true]), [['Shared plan', true]]);
  assert.equal(mine.json.canvases[0].id, ids.canvas);
  assert.deepEqual(mine.json.canvases[0].owner, {
    id: ids.owner,
    username: 'cowner',
    name: 'Canvas Owner',
    avatarColor: '#123456',
    photoVersion: mine.json.canvases[0].owner.photoVersion,
  });
  assert.equal(typeof mine.json.canvases[0].owner.photoVersion, 'number');
  assert.equal((await get(ids.member, ids.other)).status, 403, 'not a member of the other channel');
});
