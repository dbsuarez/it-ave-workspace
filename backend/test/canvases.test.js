// GET /api/canvases?channelId=: the canvases shared into a channel (the channel's Canvases tab). The old Wiki (channel Markdown pages)
// was retired: its routes are gone, so creating, reading, editing and deleting a Wiki page all answer 404.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'canvases-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const memberships = new Set(['1:7']);
const shared = [{
  id: 31, title: 'Release plan', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', role: 'editor',
  owner_id: 1, owner_username: 'alice', owner_first_name: 'Alice', owner_middle_name: null, owner_last_name: 'Lee', owner_avatar_color: '#112233', owner_photo_updated_at: null,
}];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params = []) => {
      if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('SELECT 1 FROM channel_members')) return { rows: memberships.has(`${params[1]}:${params[0]}`) ? [{}] : [] };
      if (sql.includes('FROM canvas_channel_grants')) return { rows: Number(params[0]) === 7 ? shared : [] };
      throw new Error(`Unexpected canvas query: ${sql}`);
    },
  },
};

const app = express();
app.use(express.json());
app.use('/api/canvases', require('../src/routes/canvases'));
let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

function authHeader(userId = 1) {
  const token = jwt.sign({ userId, username: userId === 1 ? 'alice' : 'bob' }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

test('the list needs a sign-in, a channel and membership of it', async () => {
  assert.equal((await fetch(`${baseUrl}/api/canvases?channelId=7`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/canvases?channelId=7`, { headers: authHeader(2) })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/canvases`, { headers: authHeader() })).status, 400);
});

test('a member gets the canvases shared into the channel, with their owner, and nothing else', async () => {
  const res = await fetch(`${baseUrl}/api/canvases?channelId=7`, { headers: authHeader() });
  assert.equal(res.status, 200);
  const { canvases } = await res.json();
  assert.equal(canvases.length, 1);
  assert.equal(canvases[0].id, 31);
  assert.equal(canvases[0].title, 'Release plan');
  assert.equal(canvases[0].shared, true);
  assert.equal(canvases[0].role, 'editor');
  assert.equal(canvases[0].owner.name, 'Alice Lee');
});

test('the retired Wiki cannot be created, read, edited or deleted any more', async () => {
  const headers = { ...authHeader(), 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${baseUrl}/api/canvases`, { method: 'POST', headers, body: JSON.stringify({ channelId: 7, title: 'Page', content: 'x' }) })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/canvases/10`, { headers })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/canvases/10`, { method: 'PUT', headers, body: JSON.stringify({ title: 'Page', content: 'y' }) })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/canvases/10`, { method: 'DELETE', headers })).status, 404);
});
