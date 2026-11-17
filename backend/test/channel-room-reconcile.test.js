const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileChannelRoom } = require('../src/channelRoomReconcile');

function fakeIO(users) {
  const sockets = users.map((id) => ({
    data: { userId: id }, rooms: new Set(['channel_17']),
    left: [], events: [],
    async leave(room) { this.left.push(room); this.rooms.delete(room); },
    emit(name, payload) { this.events.push({ name, payload }); },
  }));
  return { sockets, io: { in(room) { assert.equal(room, 'channel_17'); return { async fetchSockets() { return sockets; } }; } } };
}

test('room reconciliation evicts banned and expired users, preserving authorized members', async () => {
  const { io, sockets } = fakeIO([1, 2, 3]);
  // The central membership check asks for a channel record and its effective grants.
  const query = async (sql, params) => {
    if (sql.includes('FROM channels c')) {
      return { rows: params[1] === 1 ? [{ needs_check: false }] : [] };
    }
    throw new Error('Unexpected query');
  };
  const result = await reconcileChannelRoom(io, query, 17);
  assert.deepEqual(result, { checked: 3, evicted: 2 });
  assert.equal(sockets[0].left.length, 0);
  for (const socket of sockets.slice(1)) {
    assert.deepEqual(socket.left, ['channel_17']);
    assert.deepEqual(socket.events, [{name:'channel_access_revoked', payload: {channelId:17}}]);
  }
});

test('missing socket identity fails closed', async () => {
  const { io, sockets } = fakeIO([undefined]);
  const result = await reconcileChannelRoom(io, async () => { throw Error('should not query'); }, 17);
  assert.equal(result.evicted, 1);
  assert.equal(sockets[0].left.length, 1);
});

test('database authorization failures fail closed', async () => {
  const { io, sockets } = fakeIO([4]);
  const result = await reconcileChannelRoom(io, async () => { throw Error('DB inaccessible'); }, 17);
  assert.equal(result.evicted, 1);
  assert.equal(sockets[0].left.length, 1);
});
