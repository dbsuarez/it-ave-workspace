const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'conversations-guests-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];

const accountTypes = { 1: 'member', 2: 'member', 3: 'member', 4: 'guest', 9: 'guest' };
const executed = [];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params = []) => {
      executed.push(sql);
      if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('SELECT account_type FROM users WHERE id = $1')) {
        return { rows: [{ account_type: accountTypes[params[0]] || 'member' }] };
      }
      if (sql.includes("account_type = 'guest'")) {
        return { rows: params[0].filter((id) => accountTypes[id] === 'guest').map((id) => ({ id })) };
      }
      if (sql.includes('SELECT id FROM users WHERE id = ANY')) {
        return { rows: params[0].filter((id) => accountTypes[id]).map((id) => ({ id })) };
      }
      if (sql.includes('SELECT id FROM users WHERE id = $1')) {
        return { rows: accountTypes[params[0]] ? [{ id: params[0] }] : [] };
      }
      if (sql.includes('SELECT 1 FROM conversation_members')) return { rows: [{}] };
      if (sql.includes('SELECT user_id FROM conversation_members')) return { rows: [{ user_id: 1 }, { user_id: 2 }] };
      if (sql.includes('INSERT INTO conversations')) return { rows: [{ id: 10 }] };
      if (sql.includes('INSERT INTO conversation_members')) return { rows: [] };
      if (sql.includes('FROM conversations WHERE id = $1')) {
        return { rows: [{ id: 10, name: '', created_by: 1, created_at: new Date().toISOString() }] };
      }
      if (sql.includes('FROM conversation_members cm JOIN users u')) return { rows: [] };
      if (sql.includes('FROM conversation_messages m')) return { rows: [{ count: 0 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  },
};

const app = express();
app.use(express.json());
app.use('/api/conversations', require('../src/routes/conversations'));
let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => { executed.length = 0; });

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

function call(method, path, body, userId = 1) {
  const token = jwt.sign({ userId, username: `user${userId}` }, config.JWT_SECRET);
  return fetch(`${baseUrl}/api/conversations${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
}
const created = () => executed.some((sql) => sql.includes('INSERT INTO conversations'));
const joined = () => executed.some((sql) => sql.includes('INSERT INTO conversation_members'));

test('a guest cannot start a group message', async () => {
  const response = await call('POST', '', { memberIds: [2, 3] }, 9);
  assert.equal(response.status, 403);
  assert.equal(created(), false);
});

test('a member cannot create a group that includes a guest', async () => {
  const response = await call('POST', '', { memberIds: [2, 4] });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Guests cannot be added/);
  assert.equal(created(), false, 'nothing was created');
});

test('a group of regular members is still created', async () => {
  const response = await call('POST', '', { memberIds: [2, 3] });
  assert.equal(response.status, 201);
  assert.equal(created(), true);
});

test('a member cannot add a guest to an existing group', async () => {
  const response = await call('POST', '/10/members', { userId: 4 });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Guests cannot be added/);
  assert.equal(joined(), false, 'the guest was not added');
});

test('adding a regular member still works', async () => {
  const response = await call('POST', '/10/members', { userId: 3 });
  assert.equal(response.status, 201);
  assert.equal(joined(), true);
});
