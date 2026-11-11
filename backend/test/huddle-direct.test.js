// One-to-one ("direct") huddles: ringing, answering, cancelling, privacy and the guest rule.
// Same fake-socket harness as huddle.test.js, with a small fake database.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
process.env.JWT_SECRET = 'huddle-direct-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const guests = new Set();
const shared = new Set(); // "a:b" pairs that share a channel (both orders)
const missing = new Set();

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('SELECT id FROM users WHERE id = $1')) return { rows: missing.has(Number(params[0])) ? [] : [{ id: params[0] }] };
      if (sql.includes('SELECT id, account_type FROM users')) {
        return { rows: params[0].map((id) => ({ id, account_type: guests.has(id) ? 'guest' : 'member' })) };
      }
      if (sql.includes('JOIN channel_members theirs')) return { rows: shared.has(`${params[0]}:${params[1]}`) ? [{}] : [] };
      if (sql.includes('FROM channel_members')) return { rows: [] };
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

  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, data) { this.sent.push({ event, data }); }
  join(room) { this.rooms.add(room); }
  leave(room) { this.rooms.delete(room); }

  to(room) {
    return {
      emit: (event, data) => {
        this.io.sockets.sockets.forEach((socket) => {
          if (socket !== this && socket.rooms.has(room)) socket.emit(event, data);
        });
      },
    };
  }

  take(event) {
    const index = this.sent.findIndex((entry) => entry.event === event);
    return index < 0 ? null : this.sent.splice(index, 1)[0].data;
  }

  count(event) { return this.sent.filter((entry) => entry.event === event).length; }
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
    to(room) {
      return { emit: (event, data) => io.sockets.sockets.forEach((socket) => { if (socket.rooms.has(room)) socket.emit(event, data); }) };
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
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
});

test('calling someone rings them once, and they can answer', async () => {
  const io = createIo();
  const alice = await connectUser(io, 1, 'alice');
  const bob = await connectUser(io, 2, 'bob');

  await alice.handlers.get('huddle:join')({ withUserId: 2 });
  const aliceJoined = alice.take('huddle:joined');
  assert.equal(aliceJoined.channelId, 'dm:1-2', 'a direct call is keyed by the pair');
  assert.deepEqual(aliceJoined.direct, { userId: 2 });
  assert.deepEqual(aliceJoined.participants, []);
  const ring = bob.take('huddle:invite');
  assert.deepEqual(ring, { from: { id: 1, username: 'alice' }, key: 'dm:1-2' });

  // bob answers by joining the same call
  await bob.handlers.get('huddle:join')({ withUserId: 1 });
  const bobJoined = bob.take('huddle:joined');
  assert.equal(bobJoined.channelId, 'dm:1-2');
  assert.equal(bobJoined.participants.length, 1);
  assert.equal(bobJoined.participants[0].username, 'alice');
  assert.equal(alice.take('huddle:participant-joined').username, 'bob');
  assert.equal(bob.count('huddle:invite'), 0, 'answering does not ring anyone');
  assert.equal(alice.count('huddle:invite'), 0);

  // they can exchange signaling
  await alice.handlers.get('huddle:signal')({ to: bob.id, signal: { description: { type: 'offer', sdp: 'sdp-1' } } });
  assert.equal(bob.take('huddle:signal').signal.description.sdp, 'sdp-1');
});

test('hanging up before the other person answers stops the ringing', async () => {
  const io = createIo();
  const alice = await connectUser(io, 3, 'alice');
  const bob = await connectUser(io, 4, 'bob');
  await alice.handlers.get('huddle:join')({ withUserId: 4 });
  assert.ok(bob.take('huddle:invite'));
  alice.handlers.get('huddle:leave')();
  assert.deepEqual(bob.take('huddle:invite-cancelled'), { fromId: 3 });
});

test('a direct call holds two people, and a call between two others is not reachable', async () => {
  const io = createIo();
  const alice = await connectUser(io, 5, 'alice');
  const bob = await connectUser(io, 6, 'bob');
  const carol = await connectUser(io, 7, 'carol');
  await alice.handlers.get('huddle:join')({ withUserId: 6 });
  await bob.handlers.get('huddle:join')({ withUserId: 5 });
  alice.sent.length = 0;
  bob.sent.length = 0;

  // carol asking for the same two people gets her own call with alice, never theirs
  await carol.handlers.get('huddle:join')({ withUserId: 5 });
  assert.equal(carol.take('huddle:joined').channelId, 'dm:5-7');
  assert.equal(alice.count('huddle:participant-joined'), 0, 'nothing leaks into the call between alice and bob');
  // she cannot send signaling into alice and bob's call
  await carol.handlers.get('huddle:signal')({ to: bob.id, signal: { description: { type: 'offer', sdp: 'x' } } });
  assert.ok(carol.take('huddle:error'));
  assert.equal(bob.count('huddle:signal'), 0);
});

test('bad requests are refused', async () => {
  const io = createIo();
  const alice = await connectUser(io, 8, 'alice');
  for (const bad of [{ withUserId: 8 }, { withUserId: 'x' }, { withUserId: 0 }, { withUserId: -3 }, {}]) {
    await alice.handlers.get('huddle:join')(bad);
    assert.ok(alice.take('huddle:error'), JSON.stringify(bad));
  }
  missing.add(99);
  await alice.handlers.get('huddle:join')({ withUserId: 99 });
  assert.match(alice.take('huddle:error').error, /not found/i);
  missing.delete(99);
});

test('a guest can only call people they share a channel with', async () => {
  const io = createIo();
  const guest = await connectUser(io, 9, 'visitor');
  const member = await connectUser(io, 10, 'member');
  guests.add(9);
  await guest.handlers.get('huddle:join')({ withUserId: 10 });
  assert.match(guest.take('huddle:error').error, /Guests can only message people in their channels/);
  assert.equal(member.count('huddle:invite'), 0, 'nobody was rung');
  shared.add('9:10');
  shared.add('10:9');
  await guest.handlers.get('huddle:join')({ withUserId: 10 });
  assert.ok(guest.take('huddle:joined'));
  assert.ok(member.take('huddle:invite'));
  guests.delete(9);
});
