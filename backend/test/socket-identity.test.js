const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'socket-identity-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const memberships = new Set(['1:7', '2:8']); // "<userId>:<channelId>"

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      // yield, like a real database round trip, so racing events can interleave
      await new Promise((resolve) => setImmediate(resolve));
      if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('FROM channel_members')) {
        return { rows: memberships.has(`${params[1]}:${params[0]}`) ? [{}] : [] };
      }
      return { rows: [] };
    },
  },
};

const registerChatHandlers = require('../src/sockets/chat');

class FakeSocket {
  constructor(io, id) {
    this.io = io;
    this.id = id;
    this.data = {};
    this.rooms = new Set();
    this.handlers = new Map();
    this.sent = [];
    this.disconnected = false;
    io.sockets.sockets.set(id, this);
  }

  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, data) { this.sent.push({ event, data }); }
  join(room) { this.rooms.add(room); }
  leave(room) { this.rooms.delete(room); }
  disconnect() { this.disconnected = true; }
  events(name) { return this.sent.filter((entry) => entry.event === name); }
  to() { return { emit() {} }; }
}

function createIo() {
  return { sockets: { sockets: new Map() }, in: () => ({ fetchSockets: async () => [] }), to: () => ({ emit() {} }) };
}

const tokenFor = (userId) => jwt.sign({ userId, username: `user${userId}` }, config.JWT_SECRET);

function connect() {
  const io = createIo();
  const socket = new FakeSocket(io, 'socket-1');
  registerChatHandlers(io, socket);
  return { io, socket, authenticate: socket.handlers.get('authenticate') };
}

test.after(() => {
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

test('a connection cannot switch to another account after authenticating', async () => {
  const { socket, authenticate } = connect();
  await authenticate(tokenFor(1));
  await socket.handlers.get('join_channel')(7);
  assert.ok(socket.rooms.has('user_1') && socket.rooms.has('channel_7'));

  await authenticate(tokenFor(2));

  assert.equal(socket.disconnected, true, 'the connection is dropped');
  assert.equal(socket.events('auth_error').length, 1);
  assert.match(socket.events('auth_error')[0].data.error, /different account/);
  assert.equal(socket.rooms.has('user_2'), false, 'never joins the second account\'s room');
  assert.equal(socket.data.userId, 1, 'identity is not replaced');
});

test('repeating the same account is harmless', async () => {
  const { socket, authenticate } = connect();
  await authenticate(tokenFor(1));
  await authenticate(tokenFor(1));
  assert.equal(socket.disconnected, false);
  assert.equal(socket.events('authenticated').length, 2);
  assert.equal(socket.events('auth_error').length, 0);
});

test('two racing authenticate events cannot both succeed as different accounts', async () => {
  const { socket, authenticate } = connect();
  await Promise.all([authenticate(tokenFor(1)), authenticate(tokenFor(2))]);
  assert.equal(socket.events('authenticated').length, 1);
  assert.equal(socket.events('auth_error').length, 1);
  assert.equal(socket.rooms.has('user_1'), true, 'the first caller wins');
  assert.equal(socket.rooms.has('user_2'), false);
  assert.equal(socket.disconnected, true);
});

test('a bad token still disconnects', async () => {
  const { socket, authenticate } = connect();
  await authenticate('not-a-token');
  assert.equal(socket.disconnected, true);
  assert.equal(socket.events('authenticated').length, 0);
});
