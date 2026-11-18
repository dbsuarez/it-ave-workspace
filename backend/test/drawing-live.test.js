// Drawings: live editing. Fake sockets, a real database, and a hub that is ticked by hand instead of by a timer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let pool; let hubModule; let hub;
const ids = {};
let clock = 1_000_000;

class FakeSocket {
  constructor(io, userId) {
    this.io = io; this.id = `fs-${Math.random().toString(36).slice(2)}`; this.data = userId ? { userId } : {};
    this.handlers = new Map(); this.rooms = new Set(); this.received = [];
    io.sockets.set(this.id, this);
  }
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, payload) { this.received.push({ event, payload }); }
  join(room) { this.rooms.add(room); }
  leave(room) { this.rooms.delete(room); }
  to(room) { return { emit: (event, payload) => this.io.deliver(room, event, payload, this) }; }
  take(event) { return this.received.filter((e) => e.event === event).map((e) => e.payload); }
  call(event, payload) { return new Promise((resolve) => { const result = this.handlers.get(event)(payload, resolve); if (result && typeof result.catch === 'function') result.catch((e) => resolve({ ok: false, error: String(e.message) })); }); }
}
const fakeIo = {
  sockets: new Map(),
  deliver(room, event, payload, except) { for (const socket of this.sockets.values()) if (socket !== except && socket.rooms.has(room)) socket.emit(event, payload); },
  to(room) { return { emit: (event, payload) => fakeIo.deliver(room, event, payload, null) }; },
  in() { return { fetchSockets: async () => [] }; },
};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'drawing-live-secret';
  pool = require('../src/db').pool;
  hubModule = require('../src/sockets/drawings');
  hub = hubModule.createDrawingHub({ io: fakeIo, query: (...a) => admin.query(...a), pool, now: () => clock, saveEveryMs: 5000 });
  const forums = require('../src/forums');
  const add = async (name, type = 'member') => (await admin.query('INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', type])).rows[0].id;
  for (const name of ['ann', 'bob', 'cara', 'vi', 'out', 'ban']) ids[name] = await add(`dl-${name}`);
  ids.mis = (await admin.query("INSERT INTO departments (name) VALUES ('MIS') RETURNING id")).rows[0].id;
  for (const user of ['ann', 'bob']) await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids[user], ids.mis]);
  const q = (...a) => admin.query(...a);
  ids.forum = await forums.ensureDepartmentForum(q, ids.mis);
  ids.topic = (await admin.query("INSERT INTO forum_topics (channel_id, title, created_by) VALUES ($1, 'T', $2) RETURNING id", [ids.forum, ids.ann])).rows[0].id;
  ids.chan = (await admin.query("INSERT INTO channels (name) VALUES ('dl-chan') RETURNING id")).rows[0].id;
  for (const user of ['ann', 'bob', 'ban']) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.chan, ids[user]]);
  const draw = async (title, channel, topic) => (await admin.query('INSERT INTO drawings (title, owner_id, channel_id, topic_id) VALUES ($1, $2, $3, $4) RETURNING id', [title, ids.ann, channel || null, topic || null])).rows[0].id;
  ids.standalone = await draw('standalone');
  await admin.query("INSERT INTO drawing_members (drawing_id, user_id, role) VALUES ($1, $2, 'editor'), ($1, $3, 'viewer')", [ids.standalone, ids.cara, ids.vi]);
  ids.topicDrawing = await draw('topic', ids.forum, ids.topic);
  ids.channelDrawing = await draw('channel', ids.chan);
  ids.order1 = await draw('order one'); ids.order2 = await draw('order two'); ids.leave = await draw('leave'); ids.shut = await draw('shutdown'); ids.gone = await draw('gone'); ids.leak = await draw('leak');
});

test.after(async () => {
  if (hub) await hub.shutdown();
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const connect = (name) => { const socket = new FakeSocket(fakeIo, name ? ids[name] : null); hub.register(socket); return socket; };
const el = (id, version = 1, nonce = 1, extra = {}) => ({ id, type: 'rectangle', version, versionNonce: nonce, x: 0, ...extra });
const stored = async (id) => (await admin.query('SELECT scene, revision FROM drawings WHERE id = $1', [id])).rows[0];
const join = (socket, drawingId) => socket.call('drawing:join', { drawingId });
const update = (socket, drawingId, elements) => socket.call('drawing:update', { drawingId, elements });

test('joining returns the saved drawing with the person’s role and who is present; the others are told', async (t) => {
  if (skip(t)) return;
  const ann = connect('ann'); const cara = connect('cara');
  const first = await join(ann, ids.standalone);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.scene, { elements: [], appState: {} });
  assert.equal(first.role, 'editor');
  assert.equal(first.revision, 1);
  assert.deepEqual(first.files, []);
  assert.deepEqual(first.present.map((p) => p.username), ['dl-ann']);
  const second = await join(cara, ids.standalone);
  assert.deepEqual(second.present.map((p) => p.username).sort(), ['dl-ann', 'dl-cara']);
  assert.ok(ann.take('drawing:presence').some((e) => e.present.length === 2), 'ann learns cara arrived');
  assert.ok(first.present[0].color, 'each person has a colour');
});

test('an outsider, a signed-out connection and an unknown drawing cannot join; nothing is sent to them', async (t) => {
  if (skip(t)) return;
  const out = connect('out'); const anon = connect(null);
  const refused = await join(out, ids.standalone);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.equal((await join(anon, ids.standalone)).ok, false);
  assert.equal((await join(connect('ann'), 999999)).status, 404);
  assert.equal((await join(connect('ann'), 'abc')).ok, false);
  assert.equal(out.rooms.size, 0);
  const watcher = connect('ann'); await join(watcher, ids.standalone);
  assert.equal((await update(out, ids.standalone, [el('x')])).ok, false, 'an update without joining');
  out.handlers.get('drawing:pointer')({ drawingId: ids.standalone, pointer: { x: 1, y: 1 } });
  assert.equal(watcher.take('drawing:pointer').length, 0, 'no pointer from someone who is not in the room');
  assert.equal(watcher.take('drawing:update').length, 0);
});

test('a viewer joins and sees cursors but cannot change the drawing', async (t) => {
  if (skip(t)) return;
  const vi = connect('vi'); const ann = connect('ann');
  await join(ann, ids.standalone);
  const joined = await join(vi, ids.standalone);
  assert.equal(joined.role, 'viewer');
  const refused = await update(vi, ids.standalone, [el('v1')]);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /view/i);
  assert.equal(ann.take('drawing:update').length, 0);
  assert.equal((await stored(ids.standalone)).scene.elements.length, 0);
  clock += 1000;
  vi.handlers.get('drawing:pointer')({ drawingId: ids.standalone, pointer: { x: 5, y: 6, tool: 'pointer' } });
  assert.deepEqual(ann.take('drawing:pointer').slice(-1)[0].pointer, { x: 5, y: 6, tool: 'pointer' });
});

test('an editor’s shapes reach everyone else, are merged by version, and a stale update does not overwrite', async (t) => {
  if (skip(t)) return;
  const ann = connect('ann'); const cara = connect('cara');
  await join(ann, ids.standalone); await join(cara, ids.standalone);
  ann.received.length = 0; cara.received.length = 0;
  const sent = await update(ann, ids.standalone, [el('s1', 2, 5, { x: 10 }), el('s2', 1, 5)]);
  assert.deepEqual([sent.ok, sent.applied], [true, 2]);
  assert.deepEqual(cara.take('drawing:update')[0].elements.map((e) => e.id), ['s1', 's2']);
  assert.equal(ann.take('drawing:update').length, 0, 'the sender is not echoed');
  ann.received.length = 0; cara.received.length = 0;
  const stale = await update(cara, ids.standalone, [el('s1', 1, 1, { x: 99 })]);
  assert.deepEqual([stale.ok, stale.applied], [true, 0]);
  assert.equal(cara.take('drawing:update').length, 0, 'nothing to relay');
  const late = connect('ann'); const state = await join(late, ids.standalone);
  assert.equal(state.scene.elements.find((e) => e.id === 's1').x, 10, 'a late joiner gets the merged drawing');
});

test('the order in which two editors’ updates arrive never changes the drawing', async (t) => {
  if (skip(t)) return;
  const a = [el('p', 3, 7, { x: 1 }), el('q', 1, 9)];
  const b = [el('p', 3, 4, { x: 2 }), el('q', 2, 1, { x: 5 })];
  for (const [drawing, order] of [[ids.order1, [a, b]], [ids.order2, [b, a]]]) {
    const one = connect('ann'); const two = connect('bob');
    await admin.query("INSERT INTO drawing_members (drawing_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING", [drawing, ids.bob]);
    await join(one, drawing); await join(two, drawing);
    await update(one, drawing, order[0]); await update(two, drawing, order[1]);
  }
  await hub.tick();
  const canon = async (id) => JSON.stringify((await stored(id)).scene.elements.sort((x, y) => (x.id < y.id ? -1 : 1)));
  assert.equal(await canon(ids.order2), await canon(ids.order1));
});

test('saving: nothing is written between ticks; a tick saves once and raises the revision; a quiet tick writes nothing', async (t) => {
  if (skip(t)) return;
  const ann = connect('ann'); await join(ann, ids.channelDrawing);
  const before = await stored(ids.channelDrawing);
  await update(ann, ids.channelDrawing, [el('c1')]);
  assert.deepEqual(await stored(ids.channelDrawing), before, 'not written yet');
  await hub.tick();
  const saved = await stored(ids.channelDrawing);
  assert.equal(saved.revision, before.revision + 1);
  assert.deepEqual(saved.scene.elements.map((e) => e.id), ['c1']);
  assert.equal((await admin.query('SELECT updated_by FROM drawings WHERE id = $1', [ids.channelDrawing])).rows[0].updated_by, ids.ann);
  await hub.tick(); await hub.tick();
  assert.equal((await stored(ids.channelDrawing)).revision, saved.revision, 'nothing changed, nothing written');
  await update(ann, ids.channelDrawing, [el('c1', 2)]);
  await hub.tick();
  assert.equal((await stored(ids.channelDrawing)).revision, saved.revision + 1);
});

test('the last person leaving saves at once, a disconnect counts as leaving, and shutdown saves what is left', async (t) => {
  if (skip(t)) return;
  const ann = connect('ann'); await join(ann, ids.leave);
  await update(ann, ids.leave, [el('l1')]);
  assert.equal((await stored(ids.leave)).scene.elements.length, 0);
  assert.equal((await ann.call('drawing:leave', { drawingId: ids.leave })).ok, true);
  assert.equal((await stored(ids.leave)).scene.elements.length, 1, 'saved when the last person left');
  const bob = connect('ann'); await join(bob, ids.leave); await update(bob, ids.leave, [el('l2')]);
  await bob.handlers.get('disconnect')();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await stored(ids.leave)).scene.elements.length, 2, 'a dropped connection also saves');
  const last = connect('ann'); await join(last, ids.shut); await update(last, ids.shut, [el('z1')]);
  await hub.shutdown();
  assert.equal((await stored(ids.shut)).scene.elements.length, 1, 'shutdown saves');
});

test('someone who loses access is dropped at the next tick and their later updates are refused: moved out of the department, banned, or removed from a share', async (t) => {
  if (skip(t)) return;
  // moved out of the department
  const bob = connect('bob'); const ann = connect('ann');
  await join(bob, ids.topicDrawing); await join(ann, ids.topicDrawing);
  assert.equal((await update(bob, ids.topicDrawing, [el('t1')])).ok, true);
  await admin.query('DELETE FROM user_departments WHERE user_id = $1 AND department_id = $2', [ids.bob, ids.mis]);
  await hub.tick();
  assert.equal(bob.take('drawing:revoked').length, 1, 'told');
  assert.equal(bob.rooms.has(`drawing_${ids.topicDrawing}`), false, 'out of the room');
  assert.equal((await update(bob, ids.topicDrawing, [el('t2')])).ok, false, 'later updates refused');
  assert.ok(ann.take('drawing:presence').slice(-1)[0].present.every((p) => p.username !== 'dl-bob'), 'the others see them go');
  await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids.bob, ids.mis]);
  // banned
  const ban = connect('ban'); await join(ban, ids.channelDrawing);
  await admin.query("INSERT INTO channel_bans (channel_id, user_id, reason) VALUES ($1, $2, 'test')", [ids.chan, ids.ban]);
  await hub.tick();
  assert.equal(ban.take('drawing:revoked').length, 1);
  assert.equal((await update(ban, ids.channelDrawing, [el('b1')])).ok, false);
  // removed from a share
  const cara = connect('cara'); await join(cara, ids.standalone);
  await admin.query('DELETE FROM drawing_members WHERE drawing_id = $1 AND user_id = $2', [ids.standalone, ids.cara]);
  await hub.tick();
  assert.equal(cara.take('drawing:revoked').length, 1);
  assert.equal((await update(cara, ids.standalone, [el('c9')])).ok, false);
});

test('a drawing that becomes view-only (its topic is locked) turns editors into viewers at the next tick, without dropping them', async (t) => {
  if (skip(t)) return;
  const ann = connect('ann'); await join(ann, ids.topicDrawing);
  assert.equal((await update(ann, ids.topicDrawing, [el('lock1')])).ok, true);
  await admin.query('UPDATE forum_topics SET locked_at = NOW() WHERE id = $1', [ids.topic]);
  await hub.tick();
  assert.equal(ann.take('drawing:revoked').length, 0, 'still in the room');
  assert.ok(ann.take('drawing:role').some((e) => e.role === 'viewer' && e.readOnlyReason === 'locked'));
  assert.equal((await update(ann, ids.topicDrawing, [el('lock2')])).ok, false);
  await admin.query('UPDATE forum_topics SET locked_at = NULL WHERE id = $1', [ids.topic]);
});

test('malformed or oversize updates are refused and change nothing', async (t) => {
  if (skip(t)) return;
  const ann = connect('ann'); const watcher = connect('ann');
  await join(ann, ids.standalone); await join(watcher, ids.standalone);
  watcher.received.length = 0;
  for (const bad of ['nope', [{ id: 'x' }], [{ id: 'x', type: 't', version: 'one', versionNonce: 1 }], Array.from({ length: 20001 }, (_, i) => el(`m${i}`))]) {
    const result = await update(ann, ids.standalone, bad);
    assert.equal(result.ok, false);
    assert.match(result.error, /shape|list|many|version/i);
  }
  assert.equal(watcher.take('drawing:update').length, 0);
  const huge = await update(ann, ids.standalone, [el('big', 1, 1, { blob: 'x'.repeat(2 * 1024 * 1024) })]);
  assert.equal(huge.ok, false, 'a single update over the size cap');
});

test('updates in one drawing never reach another; a drawing deleted while open is dropped without error', async (t) => {
  if (skip(t)) return;
  const a = connect('ann'); const b = connect('ann');
  await join(a, ids.leak); await join(b, ids.standalone);
  b.received.length = 0;
  await update(a, ids.leak, [el('only-in-leak')]);
  assert.equal(b.take('drawing:update').length, 0);
  const g = connect('ann'); await join(g, ids.gone);
  await admin.query('DELETE FROM drawings WHERE id = $1', [ids.gone]);
  await hub.tick();
  assert.equal(g.rooms.has(`drawing_${ids.gone}`), false);
  assert.equal((await join(connect('ann'), ids.gone)).status, 404);
});
