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
const canvases = new Map();
let nextCanvasId = 10;

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params = []) => {
      if (sql.includes('SELECT token_version FROM users')) {
        return { rows: [{ token_version: 0 }] };
      }
      if (sql.includes('SELECT 1 FROM channel_members')) {
        return { rows: memberships.has(`${params[1]}:${params[0]}`) ? [{}] : [] };
      }
      if (sql.includes('SELECT id, channel_id, title, created_at, updated_at')) {
        return {
          rows: [...canvases.values()]
            .filter((canvas) => canvas.channel_id === Number(params[0]))
            .map(({ content, ...canvas }) => canvas),
        };
      }
      if (sql.includes('SELECT id, channel_id, title, content, created_at, updated_at FROM channel_canvases')) {
        const canvas = canvases.get(Number(params[0]));
        return { rows: canvas ? [canvas] : [] };
      }
      if (sql.includes('INSERT INTO channel_canvases')) {
        const canvas = {
          id: nextCanvasId++,
          channel_id: params[0],
          title: params[1],
          content: params[2],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        };
        canvases.set(canvas.id, canvas);
        return { rows: [canvas] };
      }
      if (sql.includes('UPDATE channel_canvases')) {
        const canvas = canvases.get(Number(params[2]));
        if (!canvas) return { rows: [] };
        canvas.title = params[0];
        canvas.content = params[1];
        canvas.updated_at = '2026-01-02T00:00:00Z';
        return { rows: [canvas] };
      }
      if (sql.includes('DELETE FROM channel_canvases')) {
        canvases.delete(Number(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM canvas_channel_grants')) return { rows: [] }; // canvases shared into the channel: none here
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

test('canvases require authentication and channel membership', async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/canvases?channelId=7`);
  assert.equal(unauthenticated.status, 401);

  const forbidden = await fetch(`${baseUrl}/api/canvases?channelId=7`, { headers: authHeader(2) });
  assert.equal(forbidden.status, 403);
});

test('members create, list, read, and update saved Markdown documents', async () => {
  const invalid = await fetch(`${baseUrl}/api/canvases`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: 7, title: 'Too long', content: 'x'.repeat(100001) }),
  });
  assert.equal(invalid.status, 400);

  const created = await fetch(`${baseUrl}/api/canvases`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: 7, title: '  Project notes  ', content: '# Plan\n- Draft' }),
  });
  const createdData = await created.json();
  assert.equal(created.status, 201);
  assert.equal(createdData.canvas.title, 'Project notes');

  const list = await fetch(`${baseUrl}/api/canvases?channelId=7`, { headers: authHeader() });
  const listData = await list.json();
  assert.equal(list.status, 200);
  assert.equal(listData.canvases[0].id, createdData.canvas.id);
  assert.equal(Object.hasOwn(listData.canvases[0], 'content'), false);

  const read = await fetch(`${baseUrl}/api/canvases/${createdData.canvas.id}`, { headers: authHeader() });
  assert.equal((await read.json()).canvas.content, '# Plan\n- Draft');

  const updated = await fetch(`${baseUrl}/api/canvases/${createdData.canvas.id}`, {
    method: 'PUT',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Release plan', content: '**ready**' }),
  });
  const updatedData = await updated.json();
  assert.equal(updated.status, 200);
  assert.equal(updatedData.canvas.title, 'Release plan');
  assert.equal(updatedData.canvas.content, '**ready**');
});

test('non-members cannot read, update, or delete another channel canvas', async () => {
  const canvas = [...canvases.values()][0];
  const read = await fetch(`${baseUrl}/api/canvases/${canvas.id}`, { headers: authHeader(2) });
  assert.equal(read.status, 403);

  const updated = await fetch(`${baseUrl}/api/canvases/${canvas.id}`, {
    method: 'PUT',
    headers: { ...authHeader(2), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Stolen', content: 'no access' }),
  });
  assert.equal(updated.status, 403);

  const deleted = await fetch(`${baseUrl}/api/canvases/${canvas.id}`, {
    method: 'DELETE',
    headers: authHeader(2),
  });
  assert.equal(deleted.status, 403);
  assert.equal(canvases.has(canvas.id), true);
});

test('members can delete canvases', async () => {
  const canvas = [...canvases.values()][0];
  const response = await fetch(`${baseUrl}/api/canvases/${canvas.id}`, {
    method: 'DELETE',
    headers: authHeader(),
  });
  assert.equal(response.status, 200);
  assert.equal(canvases.has(canvas.id), false);
});
