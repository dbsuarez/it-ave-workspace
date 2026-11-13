const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'channels-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];

// Channel state mimics a small in-memory database for the permission cases
const channels = new Map(); // id -> { id, name, topic, is_private, created_by }
const members = new Map();  // channelId -> Set of userIds, moderateIds
const moderators = new Set(); // "channelId:userId"
const superadmins = new Set([99]); // user 99 is superadmin
const guesters = new Set([50]);

const queryCalls = [];
const emitted = [];

const API = () => (sql, params = []) => {
  queryCalls.push({ sql, params });
  if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
  if (sql.includes('SELECT is_superadmin FROM users WHERE id = $1')) {
    return { rows: [{ is_superadmin: superadmins.has(Number(params[0])) }] };
  }
  if (sql.includes('SELECT default_slowmode_seconds')) return { rows: [{ default_slowmode_seconds: 5 }] };
  if (sql.includes('INSERT INTO channels')) {
    const channel = { id: 43, name: params[0], topic: params[1], is_private: params[2], is_personal: params[3],
      team_section_id: params[4], available_to_all: params[5], created_by: params[6] };
    channels.set(channel.id, channel);
    return { rows: [channel] };
  }
  if (sql.includes('CROSS JOIN users u')) {
    const id = Number(params[1]);
    return { rows: [{}] }; // all test users are members; superadmin ok
  }
  if (sql.includes('account_type') && sql.includes('FROM users')) {
    const id = Number(params[0]);
    return { rows: [{ is_superadmin: superadmins.has(id), account_type: guesters.has(id) ? 'guest' : 'member' }] };
  }
  if (sql.includes('JOIN users u ON u.id = $2')) {
    const id = Number(params[1]);
    if (superadmins.has(id)) return { rows: [{}] };
    const ch = channels.get(Number(params[0]));
    if (ch && Number(ch.created_by) === id) return { rows: [{}] };
    if (sql.includes('cm.role') && moderators.has(`${params[0]}:${id}`)) return { rows: [{}] };
    return { rows: [] };
  }
  if (sql.includes('FROM channel_members')) { // generic fallback (unused path)
    return { rows: [] };
  }
  if (sql.includes('FROM channels WHERE id = $1')) {
    const ch = channels.get(Number(params[0]));
    return { rows: ch ? [ch] : [] };
  }
  if (sql.includes('UPDATE channels SET topic')) {
    const ch = channels.get(Number(params[1]));
    if (!ch) return { rows: [] };
    ch.topic = params[0];
    return { rows: [ch] };
  }
  if (sql.includes('UPDATE channels SET name')) {
    const ch = channels.get(Number(params[1]));
    if (!ch) return { rows: [] };
    ch.name = params[0];
    return { rows: [ch] };
  }
  if (sql.includes('INSERT INTO channel_members')) {
    const key = `${params[0]}:${params[1]}`;
    if (String(params[2] ?? 'member') === 'moderator') moderators.add(key);
    return { rows: [{ role: params[2] ?? 'member' }] };
  }
  if (sql.includes('FROM roles r')) return { rows: [{ id: 3, builtin_key: 'everyone', permissions: ['create_channels'] }] };
  throw new Error(`Unexpected channels query: ${sql}`);
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { query: API() },
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.io = {
    to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
  };
  next();
});
app.use('/api/channels', require('../src/routes/channels'));
let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Seed a channel owned by user 3, moderated by user 4
  channels.set(42, { id: 42, name: 'general', topic: 'old topic', is_private: false, created_by: 3 });
  moderators.add('42:4');
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (previousDbModule) {
    require.cache[dbPath] = previousDbModule;
  } else {
    delete require.cache[dbPath];
  }
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

function authHeader(userId) {
  const token = jwt.sign({ userId, username: `u${userId}` }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

async function editTopic(userId, topic) {
  return fetch(`${baseUrl}/api/channels/42`, {
    method: 'PATCH',
    headers: { ...authHeader(userId), 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic }),
  });
}

test('channel creator can edit the topic', async () => {
  const response = await editTopic(3, 'new topic');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.channel.topic, 'new topic');
});

test('channel moderator can edit the topic', async () => {
  const response = await editTopic(4, 'moderator edit');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.channel.topic, 'moderator edit');
});

test('superadmin can edit any topic', async () => {
  const response = await editTopic(99, 'superadmin edit');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.channel.topic, 'superadmin edit');
});

test('regular member cannot edit the topic', async () => {
  const response = await editTopic(7, 'sneaky edit');
  assert.equal(response.status, 403);
});

test('guest cannot edit the topic', async () => {
  const response = await editTopic(50, 'guest edit');
  assert.equal(response.status, 403);
});

test('emits channel_topic_updated when the topic changes', async () => {
  emitted.length = 0;
  const response = await editTopic(3, 'broadcast test');
  assert.equal(response.status, 200);
  const update = emitted.find((entry) => entry.event === 'channel_topic_updated');
  assert.ok(update, 'should emit channel_topic_updated');
  assert.equal(update.room, 'channel_42');
  assert.equal(update.payload.topic, 'broadcast test');
});

test('channel creator can rename the channel', async () => {
  const response = await fetch(`${baseUrl}/api/channels/42/name`, {
    method: 'PATCH', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'renamed-channel' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).channel.name, 'renamed-channel');
});

test('channel moderator cannot rename a channel without manage_channels', async () => {
  const response = await fetch(`${baseUrl}/api/channels/42/name`, {
    method: 'PATCH', headers: { ...authHeader(4), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'moderator-rename' }),
  });
  assert.equal(response.status, 403);
});

test('create_channels allows normal channels, while manage_workspace is required for available-to-all', async () => {
  const create = (userId, name) => fetch(`${baseUrl}/api/channels`, {
    method: 'POST',
    headers: { ...authHeader(userId), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, availableToAll: true }),
  });
  assert.equal((await create(7, 'staff-only')).status, 403);
  const ordinary = await fetch(`${baseUrl}/api/channels`, {
    method: 'POST',
    headers: { ...authHeader(7), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ordinary-channel', availableToAll: false }),
  });
  assert.equal(ordinary.status, 201);
  queryCalls.length = 0;
  const response = await create(99, 'everyone');
  assert.equal(response.status, 201);
  assert.equal((await response.json()).channel.availableToAll, true);
  assert.ok(queryCalls.some(({ sql }) => sql.includes("WHERE account_type = 'member'") && sql.includes('INSERT INTO channel_members')),
    'current employees are added to an available-to-all channel');
});
