const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'search-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
let queries = [];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      if (sql.includes('SELECT token_version FROM users')) {
        return { rows: [{ token_version: 0 }] };
      }
      queries.push({ sql, params });
      if (sql.includes('SELECT m.id, m.channel_id, c.name')) {
        return { rows: [{ id: 21, channel_id: 7, channel_name: 'general', username: 'alice', content: 'budget update', created_at: '2026-01-01T00:00:00Z' }] };
      }
      if (sql.includes('FROM direct_messages dm')) {
        return { rows: [{ id: 22, other_user_id: 2, other_username: 'bob', content: 'budget approval', created_at: '2026-01-02T00:00:00Z' }] };
      }
      if (sql.includes('SELECT id, username')) {
        return { rows: [{ id: 3, username: 'budget-owner' }] };
      }
      if (sql.includes('FROM files f')) {
        return { rows: [{ id: 23, original_name: 'budget.xlsx', uploader_username: 'alice', channel_id: 7, channel_name: 'general' }] };
      }
      throw new Error('Unexpected search query');
    },
  },
};

const app = express();
app.use('/api/search', require('../src/routes/search'));
let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (previousDbModule) {
    require.cache[dbPath] = previousDbModule;
  } else {
    delete require.cache[dbPath];
  }
  if (previousJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousJwtSecret;
  }
});

function authHeader() {
  const token = jwt.sign({ userId: 1 }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

test('search returns messages, DMs, people, and only authorized file result groups', async () => {
  queries = [];
  const response = await fetch(`${baseUrl}/api/search?q=budget_%25`, { headers: authHeader() });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.messages[0].id, 21);
  assert.equal(data.directMessages[0].userId, 2);
  assert.equal(data.people[0].username, 'budget-owner');
  assert.equal(data.files[0].name, 'budget.xlsx');
  assert.equal(queries.length, 4);
  assert.ok(queries.every(({ params }) => params[0] === 1 && params[1] === '%budget\\_\\%%'));
  assert.match(queries[0].sql, /channel_members WHERE user_id = \$1/);
  assert.match(queries[1].sql, /dm\.sender_id = \$1 OR dm\.receiver_id = \$1/);
  assert.match(queries[3].sql, /dm\.sender_id = \$1 OR dm\.receiver_id = \$1/);
});

test('search rejects too-short input without querying the database', async () => {
  queries = [];
  const response = await fetch(`${baseUrl}/api/search?q=a`, { headers: authHeader() });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /at least 2 characters/);
  assert.equal(queries.length, 0);
});

test('search requires authentication', async () => {
  queries = [];
  const response = await fetch(`${baseUrl}/api/search?q=budget`);
  assert.equal(response.status, 401);
  assert.equal(queries.length, 0);
});
