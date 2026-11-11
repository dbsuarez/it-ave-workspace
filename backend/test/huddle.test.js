const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
process.env.JWT_SECRET = 'huddle-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const memberships = new Set();

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      if (sql.includes('SELECT token_version FROM users')) {
        return { rows: [{ token_version: 0 }] };
      }
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
    io.sockets.sockets.set(id, this);
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  emit(event, data) {
    this.sent.push({ event, data });
  }

  join(room) {
    this.rooms.add(room);
  }

  leave(room) {
    this.rooms.delete(room);
  }

  to(room) {
    return {
      emit: (event, data) => {
        this.io.sockets.sockets.forEach((socket) => {
          if (socket !== this && socket.rooms.has(room)) {
            socket.emit(event, data);
          }
        });
      },
    };
  }

  take(event) {
    const index = this.sent.findIndex((entry) => entry.event === event);
    if (index < 0) return null;
    return this.sent.splice(index, 1)[0].data;
  }
}

function createIo() {
  const io = {
    sockets: { sockets: new Map() },
    in(room) {
      return {
        fetchSockets: async () => Array.from(io.sockets.sockets.values())
          .filter((socket) => socket.rooms.has(room))
          .map((socket) => ({ id: socket.id, data: socket.data })),
      };
    },
  };
  return io;
}

function connectUser(io, id, username) {
  const socket = new FakeSocket(io, `socket-${id}`);
  registerChatHandlers(io, socket);
  const token = jwt.sign({ userId: id, username }, config.JWT_SECRET);
  return socket.handlers.get('authenticate')(token).then(() => socket);
}

test.after(() => {
  if (previousDbModule) {
    require.cache[dbPath] = previousDbModule;
  } else {
    delete require.cache[dbPath];
  }
});

test('channel members can join and signal; non-members are denied', async () => {
  const io = createIo();
  const channelId = 401;
  memberships.add(`1:${channelId}`);
  memberships.add(`2:${channelId}`);
  const alice = await connectUser(io, 1, 'alice');
  const bob = await connectUser(io, 2, 'bob');
  const outsider = await connectUser(io, 3, 'outsider');

  await outsider.handlers.get('huddle:join')(channelId);
  assert.match(outsider.take('huddle:error').error, /Access denied/);

  await Promise.all([
    alice.handlers.get('huddle:join')(channelId),
    bob.handlers.get('huddle:join')(channelId),
  ]);
  const aliceJoined = alice.take('huddle:joined');
  const bobJoined = bob.take('huddle:joined');
  assert.ok(aliceJoined);
  assert.ok(bobJoined);
  assert.ok(Array.isArray(aliceJoined.iceServers));
  assert.equal(aliceJoined.participants.length + bobJoined.participants.length, 1);
  const participantUpdate = alice.take('huddle:participant-joined')
    || bob.take('huddle:participant-joined');
  assert.ok(participantUpdate);
  assert.ok(['alice', 'bob'].includes(participantUpdate.username));

  await alice.handlers.get('huddle:signal')({
    to: bob.id,
    signal: { invalid: true },
  });
  assert.match(alice.take('huddle:error').error, /Invalid WebRTC signaling data/);

  await alice.handlers.get('huddle:signal')({
    to: bob.id,
    signal: { description: { type: 'offer', sdp: 'test-sdp' } },
  });
  assert.equal(bob.take('huddle:signal').signal.description.sdp, 'test-sdp');

  memberships.delete(`2:${channelId}`);
  await alice.handlers.get('huddle:signal')({
    to: bob.id,
    signal: { candidate: { candidate: 'candidate:test' } },
  });
  assert.match(alice.take('huddle:error').error, /Channel access is required/);

  memberships.delete(`1:${channelId}`);
  memberships.delete(`2:${channelId}`);
  memberships.delete(`3:${channelId}`);
});

test('concurrent joins produce a consistent roster and enforce the six-person cap', async () => {
  const io = createIo();
  const channelId = 402;
  const users = [];
  for (let id = 10; id <= 16; id += 1) {
    memberships.add(`${id}:${channelId}`);
    users.push(await connectUser(io, id, `member-${id}`));
  }

  await Promise.all(users.map((socket) => socket.handlers.get('huddle:join')(channelId)));

  const joined = users.map((socket) => socket.take('huddle:joined')).filter(Boolean);
  const errors = users.map((socket) => socket.take('huddle:error')).filter(Boolean);
  assert.equal(joined.length, 6);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /maximum 6 participants/);
  assert.deepEqual(
    joined.map((entry) => entry.participants.length).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5]
  );

  for (let id = 10; id <= 16; id += 1) {
    memberships.delete(`${id}:${channelId}`);
  }
});
