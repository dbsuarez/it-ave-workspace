const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
const previousUploadDir = process.env.UPLOAD_DIR;
process.env.JWT_SECRET = 'pins-test-secret';
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iav-pins-test-'));
process.env.UPLOAD_DIR = uploadDir;

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const messages = new Map([[5, {
  id: 5,
  channel_id: 7,
  user_id: 1,
  content: 'Keep this decision visible',
  created_at: '2025-01-01T12:00:00.000Z',
  pinned_at: null,
  pinned_by: null,
}]]);
const emitted = [];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params = []) => {
      if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('SELECT 1 FROM channel_members')) {
        return Number(params[0]) === 7 && params[1] === 1 ? { rows: [{}] } : { rows: [] };
      }
      if (sql.includes('SELECT id, channel_id FROM messages WHERE id = $1')) {
        const message = messages.get(Number(params[0]));
        return { rows: message ? [{ id: message.id, channel_id: message.channel_id }] : [] };
      }
      if (sql.includes('UPDATE messages')) {
        const message = messages.get(Number(params[2]));
        if (!message) return { rows: [] };
        message.pinned_at = params[0] ? (message.pinned_at || '2025-01-02T12:00:00.000Z') : null;
        message.pinned_by = params[0] ? params[1] : null;
        return {
          rows: [{
            id: message.id,
            channel_id: message.channel_id,
            pinned_at: message.pinned_at,
            pinned_by: message.pinned_by,
          }],
        };
      }
      if (sql.includes('SELECT m.id, m.channel_id')) {
        const pinned = [...messages.values()].filter((message) =>
          Number(message.channel_id) === Number(params[0]) && message.pinned_at
        );
        return {
          rows: pinned.map((message) => ({
            ...message,
            username: 'alice',
            avatar_color: '#A855F7',
            pinned_by_username: 'alice',
          })),
        };
      }
      if (sql.includes('FROM files WHERE message_id = ANY($1)')) return { rows: [] };
      throw new Error(`Unexpected pin query: ${sql}`);
    },
  },
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.io = {
    to: (room) => ({
      emit: (event, payload) => emitted.push({ room, event, payload }),
    }),
  };
  next();
});
app.use('/api/messages', require('../src/routes/messages'));
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
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
  if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = previousUploadDir;
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

function authHeader(userId = 1) {
  const token = jwt.sign({ userId, username: userId === 1 ? 'alice' : 'bob' }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

async function setPinned(messageId, pinned, userId = 1) {
  return fetch(`${baseUrl}/api/messages/${messageId}/pin`, {
    method: 'PATCH',
    headers: { ...authHeader(userId), 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
}

test('members can pin and unpin a message and pin updates are broadcast', async () => {
  const pinResponse = await setPinned(5, true);
  assert.equal(pinResponse.status, 200);
  assert.deepEqual((await pinResponse.json()).message, {
    messageId: 5,
    channelId: 7,
    pinned: true,
    pinnedAt: '2025-01-02T12:00:00.000Z',
    pinnedBy: 1,
  });
  assert.deepEqual(emitted.at(-1), {
    room: 'channel_7',
    event: 'message_pin_updated',
    payload: {
      messageId: 5,
      channelId: 7,
      pinned: true,
      pinnedAt: '2025-01-02T12:00:00.000Z',
      pinnedBy: 1,
    },
  });

  const listResponse = await fetch(`${baseUrl}/api/messages/7/pins`, { headers: authHeader() });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.messages.length, 1);
  assert.equal(list.messages[0].content, 'Keep this decision visible');
  assert.equal(list.messages[0].pinned, true);

  const unpinResponse = await setPinned(5, false);
  assert.equal(unpinResponse.status, 200);
  assert.equal((await unpinResponse.json()).message.pinned, false);
  const emptyListResponse = await fetch(`${baseUrl}/api/messages/7/pins`, { headers: authHeader() });
  assert.deepEqual((await emptyListResponse.json()).messages, []);
});

test('pin operations require channel membership and valid message input', async () => {
  assert.equal((await setPinned(5, true, 2)).status, 403);
  const inaccessiblePins = await fetch(`${baseUrl}/api/messages/7/pins`, { headers: authHeader(2) });
  assert.equal(inaccessiblePins.status, 403);
  assert.equal((await setPinned('invalid', true)).status, 400);
  assert.equal((await setPinned(5, 'yes')).status, 400);
  assert.equal((await setPinned(999, true)).status, 404);
  assert.equal(messages.get(5).pinned_at, null);
});
