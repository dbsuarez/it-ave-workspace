// A View as live connection only listens (it never acts as the person), with a fake database and sockets.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'socket-view-as-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const calls = [];
let ownerStillOwner = true;

require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      calls.push(sql);
      if (sql.includes('CROSS JOIN users u')) return { rows: params[0] === 7 ? [{ needs_check: false }] : [] }; // channel membership: the person is in channel 7 only
      if (sql.includes('is_superadmin = TRUE')) return { rows: ownerStillOwner ? [{}] : [] };
      if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('FROM channel_members')) return { rows: params[0] === 7 ? [{}] : [] }; // the person is in channel 7 only
      return { rows: [] };
    },
  },
};

const registerChatHandlers = require('../src/sockets/chat');

test.after(() => {
  if (previousDbModule) require.cache[dbPath] = previousDbModule; else delete require.cache[dbPath];
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousJwtSecret;
});

function connect() {
  const socket = { data: {}, rooms: new Set(), handlers: new Map(), sent: [], disconnected: false };
  socket.on = (event, handler) => socket.handlers.set(event, handler);
  socket.emit = (event, data) => socket.sent.push({ event, data });
  socket.join = (room) => socket.rooms.add(room);
  socket.leave = (room) => socket.rooms.delete(room);
  socket.disconnect = () => { socket.disconnected = true; };
  socket.to = () => ({ emit() {} });
  const io = { sockets: { sockets: new Map() }, in: () => ({ fetchSockets: async () => [] }), to: () => ({ emit() {} }) };
  registerChatHandlers(io, socket);
  return socket;
}
const viewToken = () => jwt.sign({ userId: 5, username: 'ann', tokenVersion: 0, viewAs: 1 }, config.JWT_SECRET);
const fire = (socket, event, data) => socket.handlers.get(event)(data);

test('it is accepted as listen-only, joins only the person\'s channels, and never joins their personal room', async () => {
  const socket = connect();
  await fire(socket, 'authenticate', viewToken());
  assert.deepEqual(socket.sent.map((s) => s.event), ['authenticated']);
  assert.equal(socket.sent[0].data.viewAs, true);
  assert.ok(![...socket.rooms].some((room) => room.startsWith('user_')), 'no personal room: no DMs, no notifications');
  await fire(socket, 'join_channel', 7);
  assert.ok(socket.rooms.has('channel_7'));
  await fire(socket, 'join_channel', 8);
  assert.ok(!socket.rooms.has('channel_8'), 'a channel they are not in');
});

test('it never marks the person online and cannot send or type as them', async () => {
  calls.length = 0;
  const socket = connect();
  await fire(socket, 'authenticate', viewToken());
  await fire(socket, 'send_message', { channelId: 7, content: 'nope' });
  await fire(socket, 'send_direct_message', { toUserId: 2, content: 'nope' });
  await fire(socket, 'typing', { channelId: 7, isTyping: true });
  assert.ok(!calls.some((sql) => /UPDATE users SET status/.test(sql)), 'no presence change');
  assert.ok(!calls.some((sql) => /INSERT INTO/.test(sql)), 'nothing written');
  await socket.handlers.get('disconnect')();
  assert.ok(!calls.some((sql) => /UPDATE users SET status/.test(sql)), 'and not marked offline either');
});

test('it is refused when the Owner who started it is no longer an Owner', async () => {
  ownerStillOwner = false;
  const socket = connect();
  await fire(socket, 'authenticate', viewToken());
  assert.equal(socket.sent[0].event, 'auth_error');
  assert.equal(socket.disconnected, true);
  ownerStillOwner = true;
});
