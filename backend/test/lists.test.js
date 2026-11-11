const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'lists-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const memberships = new Set(['1:7', '2:7']);
const queryCalls = [];
const insertedLists = [];
const insertedItems = [];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params = []) => {
      queryCalls.push({ sql, params });
      if (sql.includes('SELECT token_version FROM users')) {
        return { rows: [{ token_version: 0 }] };
      }
      if (sql.includes('SELECT 1 FROM channel_members')) {
        return { rows: memberships.has(`${params[1]}:${params[0]}`) ? [{}] : [] };
      }
      if (sql.includes('SELECT l.id, l.channel_id')) {
        return {
          rows: [{
            id: 11,
            channel_id: 7,
            channel_name: 'general',
            title: 'Release checklist',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            item_id: 21,
            item_title: 'Review release notes',
            is_completed: false,
            assignee_id: 2,
            assignee_name: 'bob',
            due_date: '2026-02-01',
            item_created_at: '2026-01-01T00:00:00Z',
            item_updated_at: '2026-01-02T00:00:00Z',
          }],
        };
      }
      if (sql.includes('SELECT u.id, u.username')) {
        return { rows: [{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }] };
      }
      if (sql.includes('SELECT channel_id FROM channel_lists')) {
        return { rows: Number(params[0]) === 11 ? [{ channel_id: 7 }] : [] };
      }
      if (sql.includes('INSERT INTO channel_lists')) {
        const list = {
          id: 12,
          channel_id: params[0],
          title: params[1],
          created_at: '2026-01-03T00:00:00Z',
          updated_at: '2026-01-03T00:00:00Z',
        };
        insertedLists.push(list);
        return { rows: [list] };
      }
      if (sql.includes('INSERT INTO channel_list_items')) {
        const item = {
          id: 22,
          title: params[1],
          is_completed: false,
          assignee_id: params[2],
          due_date: params[3],
          created_at: '2026-01-03T00:00:00Z',
          updated_at: '2026-01-03T00:00:00Z',
        };
        insertedItems.push(item);
        return { rows: [item] };
      }
      if (sql.includes('SELECT username FROM users')) {
        return { rows: [{ username: 'bob' }] };
      }
      if (sql.includes('SELECT id FROM channel_list_items')) {
        return { rows: Number(params[0]) === 21 && Number(params[1]) === 11 ? [{ id: 21 }] : [] };
      }
      if (sql.includes('UPDATE channel_list_items')) {
        return {
          rows: [{
            id: params.at(-2),
            title: 'Review release notes',
            is_completed: params[0],
            assignee_id: 2,
            due_date: '2026-02-01',
            updated_at: '2026-01-04T00:00:00Z',
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  },
};

const app = express();
app.use(express.json());
app.use('/api/lists', require('../src/routes/lists'));
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

function authHeader(userId = 1) {
  const token = jwt.sign({ userId, username: userId === 1 ? 'alice' : 'bob' }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

test('lists return channel-scoped items and member choices', async () => {
  const response = await fetch(`${baseUrl}/api/lists?channelId=7`, { headers: authHeader() });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.lists[0].title, 'Release checklist');
  assert.equal(data.lists[0].items[0].assigneeName, 'bob');
  assert.deepEqual(data.members.map((member) => member.username), ['alice', 'bob']);
  assert.ok(queryCalls.some(({ sql }) => sql.includes('member.user_id = $1')));
});

test('non-members cannot read or create channel lists', async () => {
  const readResponse = await fetch(`${baseUrl}/api/lists?channelId=8`, { headers: authHeader() });
  assert.equal(readResponse.status, 403);

  const createResponse = await fetch(`${baseUrl}/api/lists`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: 8, title: 'Private work' }),
  });
  assert.equal(createResponse.status, 403);
  assert.equal(insertedLists.length, 0);
});

test('list creation trims the title and rejects empty titles', async () => {
  const invalid = await fetch(`${baseUrl}/api/lists`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: 7, title: '   ' }),
  });
  assert.equal(invalid.status, 400);

  const response = await fetch(`${baseUrl}/api/lists`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: 7, title: '  Sprint tasks  ' }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.list.title, 'Sprint tasks');
  assert.equal(insertedLists.at(-1).title, 'Sprint tasks');
});

test('items validate same-channel assignees and preserve due dates', async () => {
  const before = insertedItems.length;
  const invalid = await fetch(`${baseUrl}/api/lists/11/items`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Review docs', assigneeId: 99 }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(insertedItems.length, before);

  const response = await fetch(`${baseUrl}/api/lists/11/items`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: ' Review docs ', assigneeId: 2, dueDate: '2026-02-01' }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.item.title, 'Review docs');
  assert.equal(data.item.assigneeName, 'bob');
  assert.equal(data.item.dueDate, '2026-02-01');
});

test('item completion updates require list membership and a boolean value', async () => {
  const invalid = await fetch(`${baseUrl}/api/lists/11/items/21`, {
    method: 'PATCH',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed: 'yes' }),
  });
  assert.equal(invalid.status, 400);

  const response = await fetch(`${baseUrl}/api/lists/11/items/21`, {
    method: 'PATCH',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed: true }),
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.item.completed, true);
});

test('list routes require authentication', async () => {
  const response = await fetch(`${baseUrl}/api/lists?channelId=7`);
  assert.equal(response.status, 401);
});
