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
const reactions = []; // { id, messageId, userId, emoji }
let nextReactionId = 1;
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
      if (sql.includes('FROM messages WHERE id = $1') || sql.includes('FROM messages m WHERE m.id = $1')) {
        return { rows: [{ channel_id: 7, user_id: 2, content: 'original message' }] };
      }
      if (sql.includes('FROM channels c CROSS JOIN users u')) {
        return { rows: [{ channel_name: 'general', username: 'alice', avatar_color: '#123456' }] };
      }
      if (sql.includes('SELECT 1 FROM channel_members')) {
        return params[0] === 7 && params[1] === 1 ? { rows: [{}] } : { rows: [] };
      }
      if (sql.includes('SELECT id, emoji FROM reactions')) {
        return {
          rows: reactions
            .filter((r) => Number(r.messageId) === Number(params[0]) && Number(r.userId) === Number(params[1]))
            .map((r) => ({ id: r.id, emoji: r.emoji })),
        };
      }
      if (sql.includes('INSERT INTO reactions')) {
        reactions.push({ id: nextReactionId++, messageId: Number(params[0]), userId: Number(params[1]), emoji: params[2] });
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM reactions') && sql.includes('WHERE id = $1')) {
        const index = reactions.findIndex((r) => r.id === Number(params[0]));
        if (index !== -1) reactions.splice(index, 1);
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM reactions')) {
        for (let i = reactions.length - 1; i >= 0; i -= 1) {
          const r = reactions[i];
          if (Number(r.messageId) === Number(params[0]) && Number(r.userId) === Number(params[1])) {
            reactions.splice(i, 1);
          }
        }
        return { rows: [] };
      }
      if (sql.includes('FROM reactions') && sql.includes('GROUP BY emoji')) {
        const byEmoji = new Map();
        for (const entry of reactions) {
          if (Number(entry.messageId) !== Number(params[0])) continue;
          if (!byEmoji.has(entry.emoji)) byEmoji.set(entry.emoji, []);
          byEmoji.get(entry.emoji).push(Number(entry.userId));
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
  assert.equal(reactions.some((r) => r.emoji === '🎉'), false);
  assert.ok(queryCalls.some(({ sql }) => sql.includes('DELETE FROM reactions')));
});

test('adding a different emoji replaces the previous one', async () => {
  reactions.length = 0;
  emitted.length = 0;

  const first = await react('👍');
  assert.equal(first.status, 201);

  const second = await react('❤️');
  assert.equal(second.status, 201);

  const emojiList = reactions.map((r) => r.emoji);
  assert.deepEqual(emojiList, ['❤️']);
});

test('clicking a different emoji when none exist leaves exactly one reaction', async () => {
  reactions.length = 0;
  emitted.length = 0;

  await react('👍');
  await react('🔥');
  await react('🤔');

  const mine = reactions.filter((r) => r.userId === 1);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].emoji, '🤔');
});

test('reaction changes are broadcast to the channel with current counts and users', async () => {
  reactions.length = 0;
  emitted.length = 0;

  await react('🚀');
  assert.deepEqual(emitted.find((entry) => entry.event === 'message_reactions_updated'), {
    room: 'channel_7',
    event: 'message_reactions_updated',
    payload: {
      messageId: 5,
      channelId: 7,
      reactions: [{ emoji: '🚀', count: 1, users: [1] }],
    },
  });

  await react('🚀');
  const updates = emitted.filter((entry) => entry.event === 'message_reactions_updated');
  assert.equal(updates.length, 2);
  assert.deepEqual(updates.at(-1).payload.reactions, []);
});

test('broadcast reflects the replacement after a different emoji is chosen', async () => {
  reactions.length = 0;
  emitted.length = 0;

  await react('👍');
  await react('❤️');
  const updates = emitted.filter((entry) => entry.event === 'message_reactions_updated');
  const last = updates.at(-1);
  assert.deepEqual(last.payload.reactions, [
    { emoji: '❤️', count: 1, users: [1] },
  ]);
});

test('adding a reaction notifies the message author, removing it does not', async () => {
  reactions.length = 0;
  emitted.length = 0;

  await react('👏');
  const added = emitted.filter((entry) => entry.event === 'activity');
  assert.equal(added.length, 1);
  assert.equal(added[0].room, 'user_2');
  assert.deepEqual(
    {
      type: added[0].payload.type,
      messageId: added[0].payload.messageId,
      channelId: added[0].payload.channelId,
      channelName: added[0].payload.channelName,
      actorId: added[0].payload.actorId,
      actorUsername: added[0].payload.actorUsername,
      emoji: added[0].payload.emoji,
      preview: added[0].payload.preview,
    },
    {
      type: 'reaction',
      messageId: 5,
      channelId: 7,
      channelName: 'general',
      actorId: 1,
      actorUsername: 'alice',
      emoji: '👏',
      preview: 'original message',
    }
  );

  await react('👏');
  assert.equal(emitted.filter((entry) => entry.event === 'activity').length, 1);
});
