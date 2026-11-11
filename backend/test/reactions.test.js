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
process.env.JWT_SECRET = 'reactions-test-secret';
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iav-reactions-test-'));
process.env.UPLOAD_DIR = uploadDir;

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const reactions = new Set();
const queryCalls = [];
const emitted = [];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params = []) => {
      queryCalls.push({ sql, params });
      if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('SELECT channel_id FROM messages')) return { rows: [{ channel_id: 7 }] };
      if (sql.includes('SELECT 1 FROM channel_members')) {
        return params[0] === 7 && params[1] === 1 ? { rows: [{}] } : { rows: [] };
      }
      if (sql.includes('SELECT id FROM reactions')) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        return { rows: reactions.has(key) ? [{ id: 1 }] : [] };
      }
      if (sql.includes('INSERT INTO reactions')) {
        reactions.add(`${params[0]}:${params[1]}:${params[2]}`);
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM reactions')) {
        reactions.delete(`${params[0]}:${params[1]}:${params[2]}`);
        return { rows: [] };
      }
      if (sql.includes('FROM reactions') && sql.includes('GROUP BY emoji')) {
        const byEmoji = new Map();
        for (const key of reactions) {
          const [messageId, userId, emoji] = key.split(':');
          if (Number(messageId) !== Number(params[0])) continue;
          if (!byEmoji.has(emoji)) byEmoji.set(emoji, []);
          byEmoji.get(emoji).push(Number(userId));
        }
        return { rows: [...byEmoji].map(([emoji, users]) => ({ emoji, count: users.length, users })) };
      }
      throw new Error(`Unexpected reaction query: ${sql}`);
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

function authHeader() {
  const token = jwt.sign({ userId: 1, username: 'alice' }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

async function react(emoji) {
  return fetch(`${baseUrl}/api/messages/5/reactions`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji }),
  });
}

test('accepts single emoji, flags, and joined emoji reactions', async () => {
  for (const emoji of ['👍', '🇵🇭', '👨‍👩‍👧‍👦', '1️⃣']) {
    const response = await react(emoji);
    assert.equal(response.status, 201, `${emoji} should be accepted`);
  }
});

test('rejects empty, non-emoji, multiple, and overlong reactions', async () => {
  for (const emoji of ['', 'hello', '😀😀', '👍'.repeat(11)]) {
    const response = await react(emoji);
    assert.equal(response.status, 400, `${JSON.stringify(emoji)} should be rejected`);
  }
});

test('clicking the same emoji toggles the reaction off', async () => {
  const first = await react('🎉');
  const second = await react('🎉');
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(reactions.has('5:1:🎉'), false);
  assert.ok(queryCalls.some(({ sql }) => sql.includes('DELETE FROM reactions')));
});

test('reaction changes are broadcast to the channel with current counts and users', async () => {
  reactions.clear();
  emitted.length = 0;

  await react('🚀');
  assert.deepEqual(emitted.at(-1), {
    room: 'channel_7',
    event: 'message_reactions_updated',
    payload: {
      messageId: 5,
      channelId: 7,
      reactions: [{ emoji: '🚀', count: 1, users: [1] }],
    },
  });

  await react('🚀');
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.at(-1).payload.reactions, []);
});
