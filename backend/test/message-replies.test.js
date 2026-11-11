const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'message-replies-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const memberships = new Set(['1:7']);
const parents = new Map([
  [10, { id: 10, channel_id: 7, content: 'Original message', username: 'alice' }],
  [11, { id: 11, channel_id: 8, content: 'Other channel', username: 'bob' }],
]);
const insertedMessages = [];
let nextMessageId = 100;

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      if (sql.includes('SELECT token_version FROM users')) {
        return { rows: [{ token_version: 0 }] };
      }
      if (sql.includes('SELECT 1 FROM channel_members')) {
        return { rows: memberships.has(`${params[1]}:${params[0]}`) ? [{}] : [] };
      }
      if (sql.includes('WHERE m.id = $1 AND m.channel_id = $2')) {
        const parent = parents.get(Number(params[0]));
        return { rows: parent && parent.channel_id === Number(params[1]) ? [parent] : [] };
      }
      if (sql.includes('INSERT INTO messages')) {
        const message = {
          id: nextMessageId++,
          channel_id: params[0],
          user_id: params[1],
          content: params[2],
          reply_to: params[3],
          created_at: new Date().toISOString(),
        };
        insertedMessages.push(message);
        return { rows: [message] };
      }
      if (sql.includes('SELECT username, avatar_color FROM users')) {
        return { rows: [{ username: 'alice', avatar_color: '#123456' }] };
      }
      if (sql.includes('FROM files WHERE message_id')) return { rows: [] };
      return { rows: [] };
    },
  },
};

const registerChatHandlers = require('../src/sockets/chat');

class FakeSocket {
  constructor(io) {
    this.io = io;
    this.id = 'socket-1';
    this.data = {};
    this.handlers = new Map();
    this.sent = [];
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  emit(event, data) {
    this.sent.push({ event, data });
  }

  join() {}

  take(event) {
    const index = this.sent.findIndex((entry) => entry.event === event);
    if (index < 0) return null;
    return this.sent.splice(index, 1)[0].data;
  }
}

function createSocket() {
  const io = {
    emitted: [],
    to(room) {
      return { emit: (event, data) => io.emitted.push({ room, event, data }) };
    },
  };
  const socket = new FakeSocket(io);
  registerChatHandlers(io, socket);
  const token = jwt.sign({ userId: 1, username: 'alice' }, config.JWT_SECRET);
  return socket.handlers.get('authenticate')(token).then(() => ({ io, socket }));
}

test.after(() => {
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

test('channel replies are broadcast with an inline parent preview', async () => {
  const { io, socket } = await createSocket();
  await socket.handlers.get('send_message')({
    channelId: 7,
    content: 'A reply',
    replyTo: 10,
  });

  assert.equal(insertedMessages.at(-1).reply_to, 10);
  const broadcast = io.emitted.at(-1);
  assert.equal(broadcast.room, 'channel_7');
  assert.equal(broadcast.event, 'new_message');
  assert.equal(broadcast.data.replyTo, 10);
  assert.deepEqual(broadcast.data.replyToMessage, {
    id: 10,
    username: 'alice',
    content: 'Original message',
  });
  assert.equal(socket.take('message_sent').messageId, insertedMessages.at(-1).id);
});

test('channel replies cannot reference a message in another channel', async () => {
  const { io, socket } = await createSocket();
  const insertedCount = insertedMessages.length;

  await socket.handlers.get('send_message')({
    channelId: 7,
    content: 'Invalid cross-channel reply',
    replyTo: 11,
  });

  assert.equal(insertedMessages.length, insertedCount);
  assert.equal(io.emitted.length, 0);
  assert.match(socket.take('message_error').error, /not found in this channel/);
});
