// The live session of one open drawing: local copy, live updates, offline work and the merge on reconnect. All fakes, no page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDrawingStore, memoryDrawingBackend } = require('../src/features/drawing-store');
const { createDrawingSession } = require('../src/features/drawing-session');
const { mergeElementsLocal } = require('../src/features/drawing-sync');

const el = (id, version = 1, nonce = 1, extra = {}) => ({ id, type: 'rectangle', version, versionNonce: nonce, ...extra });
const GOOD_JOIN = { ok: true, scene: { elements: [], appState: {} }, files: [], revision: 1, role: 'editor', readOnlyReason: null, present: [] };

function setup({ online = true, join = null } = {}) {
  const sent = []; const handlers = new Map(); const calls = [];
  const scheduled = []; let clock = 0; let nextTimer = 1;
  const timers = {
    set: (fn, ms) => { const timer = { id: nextTimer++, at: clock + ms, fn }; scheduled.push(timer); return timer.id; },
    clear: (timerId) => { const i = scheduled.findIndex((t) => t.id === timerId); if (i >= 0) scheduled.splice(i, 1); },
  };
  const advance = async (ms) => {
    clock += ms;
    for (const timer of scheduled.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)) { scheduled.splice(scheduled.indexOf(timer), 1); await timer.fn(); }
  };
  const socket = {
    connected: online,
    emit(event, payload, ack) {
      sent.push({ event, payload });
      if (event === 'drawing:join' && ack) ack(join || GOOD_JOIN);
      else if (event === 'drawing:update' && ack) ack({ ok: true, applied: payload.elements.length });
      else if (ack) ack({ ok: true });
    },
    on(event, handler) { handlers.set(event, handler); },
    off(event) { handlers.delete(event); },
  };
  const editor = {
    elements: [], updates: [], viewOnly: null, collaborators: null,
    getElements() { return this.elements; },
    updateElements(remote) { this.updates.push(remote); this.elements = mergeElementsLocal(this.elements, remote); },
    setViewOnly(value) { this.viewOnly = value; },
    setCollaborators(list) { this.collaborators = list; },
  };
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    if (path === '/api/drawings' && options.method === 'POST') return { ok: true, status: 201, json: async () => ({ drawing: { id: 55, title: 'Draft' } }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const store = createDrawingStore(memoryDrawingBackend());
  const statuses = []; const notices = []; const idChanges = []; const present = [];
  const session = createDrawingSession({
    store, socket, api, editor, timers, now: () => clock,
    onStatus: (status) => statuses.push(status), onNotice: (n) => notices.push(n), onIdChanged: (n) => idChanges.push(n), onPresence: (p) => present.push(p),
  });
  const server = (event, payload) => handlers.get(event)(payload);
  return { session, socket, editor, store, sent, calls, statuses, notices, idChanges, present, advance, server, handlers };
}
const updatesSent = (ctx) => ctx.sent.filter((s) => s.event === 'drawing:update').flatMap((s) => s.payload.elements.map((e) => e.id)).sort();

test('changes are saved on this computer a second after the last change, not before', async () => {
  const ctx = setup();
  await ctx.session.open(7, { title: 'Map', kind: 'standalone' });
  ctx.session.localChange([el('a')], {});
  await ctx.advance(500);
  assert.equal(await ctx.store.load(7), undefined, 'not yet');
  ctx.session.localChange([el('a', 2, 1, { x: 5 })], {});
  await ctx.advance(600);
  assert.equal(await ctx.store.load(7), undefined, 'the timer restarted with the new change');
  await ctx.advance(500);
  const saved = await ctx.store.load(7);
  assert.equal(saved.elements[0].version, 2);
  assert.equal(saved.title, 'Map');
});

test('online, new shapes are sent at once, only the ones that changed, and the status goes saving then saved', async () => {
  const ctx = setup();
  await ctx.session.open(7, { title: 'Map' });
  ctx.sent.length = 0;
  ctx.session.localChange([el('a'), el('b')], {});
  assert.deepEqual(updatesSent(ctx), ['a', 'b']);
  ctx.sent.length = 0;
  ctx.session.localChange([el('a'), el('b', 2, 1, { x: 1 })], {});
  assert.deepEqual(updatesSent(ctx), ['b'], 'a was already sent');
  assert.ok(ctx.statuses.includes('saving') && ctx.statuses[ctx.statuses.length - 1] === 'saved');
});

test('offline, edits are kept and nothing is sent; coming back online merges the server version and sends only what differs, deletions included', async () => {
  const ctx = setup({
    online: false,
    join: { ok: true, scene: { elements: [el('a', 1), el('b', 1), el('theirs', 4, 1, { x: 77 })], appState: {} }, files: [], revision: 9, role: 'editor', readOnlyReason: null, present: [] },
  });
  ctx.editor.elements = [el('a', 1), el('b', 1)];
  await ctx.session.open(7, { title: 'Map' });
  assert.equal(ctx.sent.length, 0, 'offline: no join, no sends');
  assert.equal(ctx.statuses[ctx.statuses.length - 1], 'offline');
  ctx.editor.elements = [el('a', 2, 1, { isDeleted: true }), el('b', 1), el('mine', 1)];
  ctx.session.localChange(ctx.editor.elements, {});
  await ctx.advance(1100);
  assert.equal((await ctx.store.load(7)).dirty, true, 'kept on this computer, marked unsynced');
  assert.equal(ctx.sent.length, 0);
  ctx.socket.connected = true;
  await ctx.session.reconnect();
  assert.equal(ctx.sent[0].event, 'drawing:join');
  assert.deepEqual(ctx.editor.updates[0].map((e) => e.id).sort(), ['a', 'b', 'theirs'], 'the server copy is merged into the open drawing');
  assert.deepEqual(updatesSent(ctx), ['a', 'mine'], 'only what differs: the deletion of a and the new shape');
  assert.equal(ctx.editor.elements.find((e) => e.id === 'theirs').x, 77, 'their shape is kept');
  assert.equal(ctx.editor.elements.find((e) => e.id === 'a').isDeleted, true, 'the deletion is kept');
  await ctx.advance(1100);
  const after = await ctx.store.load(7);
  assert.equal(after.dirty, false);
  assert.equal(after.lastRevision, 9);
  assert.equal(ctx.statuses[ctx.statuses.length - 1], 'saved');
});

test('a draft made offline gets a real drawing on the server at the first sync, and its local id is renamed', async () => {
  const ctx = setup({ online: false });
  await ctx.session.open('local-1', { title: 'Draft', kind: 'standalone' });
  ctx.editor.elements = [el('d1')];
  ctx.session.localChange(ctx.editor.elements, { img1: { id: 'img1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' } });
  await ctx.advance(1100);
  assert.equal(ctx.calls.length, 0, 'offline: no request');
  assert.ok(await ctx.store.load('local-1'));
  ctx.socket.connected = true;
  await ctx.session.reconnect();
  const create = ctx.calls.find((c) => c.method === 'POST' && c.path === '/api/drawings');
  assert.equal(create.body.title, 'Draft');
  assert.deepEqual(create.body.scene.elements.map((e) => e.id), ['d1']);
  assert.deepEqual(create.body.files, [{ key: 'img1', mime: 'image/png', dataBase64: 'AAAA' }]);
  assert.deepEqual(ctx.idChanges, [55]);
  assert.equal(await ctx.store.load('local-1'), undefined);
  assert.ok(await ctx.store.load(55));
  assert.equal(ctx.sent[0].event, 'drawing:join');
  assert.equal(ctx.sent[0].payload.drawingId, 55);
});

test('losing access (join refused) keeps the local copy and says it cannot sync; nothing more is sent', async () => {
  const ctx = setup({ join: { ok: false, error: 'Access denied', status: 403 } });
  ctx.editor.elements = [el('a')];
  await ctx.session.open(7, { title: 'Map' });
  assert.equal(ctx.statuses[ctx.statuses.length - 1], 'cannot-sync');
  ctx.session.localChange([el('a', 2)], {});
  await ctx.advance(1100);
  assert.equal(ctx.sent.filter((s) => s.event === 'drawing:update').length, 0);
  const kept = await ctx.store.load(7);
  assert.equal(kept.elements[0].version, 2, 'the work is still there');
  assert.equal(kept.dirty, true);
});

test('a drawing deleted while you were away is reported, and "save as my own" turns the local copy into a new standalone drawing', async () => {
  const ctx = setup({ join: { ok: false, error: 'Drawing not found', status: 404 } });
  ctx.editor.elements = [el('keep')];
  await ctx.session.open(7, { title: 'Gone', kind: 'channel' });
  ctx.session.localChange(ctx.editor.elements, {});
  await ctx.advance(1100);
  assert.ok(ctx.notices.some((n) => n.type === 'deleted'));
  assert.equal(ctx.statuses[ctx.statuses.length - 1], 'cannot-sync');
  const newId = await ctx.session.saveAsOwn();
  assert.equal(newId, 55);
  const create = ctx.calls.find((c) => c.method === 'POST' && c.path === '/api/drawings');
  assert.deepEqual([create.body.title, create.body.channelId, create.body.scene.elements[0].id], ['Gone', undefined, 'keep'], 'standalone, not in the old channel');
  assert.ok(await ctx.store.load(55));
  assert.equal(await ctx.store.load(7), undefined);
});

test('what others draw is applied to the open drawing and not sent back; their cursors and who is here are passed on', async () => {
  const ctx = setup();
  await ctx.session.open(7, { title: 'Map' });
  ctx.editor.elements = [el('a')];
  ctx.server('drawing:update', { drawingId: 7, elements: [el('x', 3, 1, { x: 8 })], from: 2 });
  assert.deepEqual(ctx.editor.updates[ctx.editor.updates.length - 1].map((e) => e.id), ['x']);
  ctx.sent.length = 0;
  ctx.session.localChange([el('a'), el('x', 3, 1, { x: 8 })], {});
  assert.deepEqual(updatesSent(ctx), ['a'], 'x came from the server, so it is not sent back');
  ctx.server('drawing:presence', { drawingId: 7, present: [{ userId: 2, username: 'bob', color: '#00f' }] });
  assert.deepEqual(ctx.present[ctx.present.length - 1].map((p) => p.username), ['bob']);
  ctx.server('drawing:pointer', { drawingId: 7, pointer: { x: 1, y: 2 }, userId: 2, username: 'bob', color: '#00f' });
  assert.deepEqual(ctx.editor.collaborators.map((c) => [c.username, c.pointer.x]), [['bob', 1]]);
  ctx.server('drawing:update', { drawingId: 999, elements: [el('other')] });
  assert.equal(ctx.editor.updates.length, 1, 'another drawing updates are ignored');
});

test('events about the role: becoming view-only switches the editor off; being revoked cannot sync', async () => {
  const ctx = setup();
  await ctx.session.open(7, { title: 'Map' });
  assert.equal(ctx.editor.viewOnly, false);
  ctx.server('drawing:role', { drawingId: 7, role: 'viewer', readOnlyReason: 'locked' });
  assert.equal(ctx.editor.viewOnly, true);
  ctx.server('drawing:revoked', { drawingId: 7 });
  assert.equal(ctx.statuses[ctx.statuses.length - 1], 'cannot-sync');
  ctx.sent.length = 0;
  ctx.session.localChange([el('after')], {});
  assert.equal(ctx.sent.length, 0);
});

test('a viewer own edits are never sent', async () => {
  const ctx = setup({ join: { ...GOOD_JOIN, role: 'viewer' } });
  await ctx.session.open(7, { title: 'Map' });
  assert.equal(ctx.editor.viewOnly, true);
  ctx.session.localChange([el('v')], {});
  assert.equal(ctx.sent.filter((s) => s.event === 'drawing:update').length, 0);
});

test('a large drawing is sent in batches under the size cap, nothing lost', async () => {
  const ctx = setup();
  await ctx.session.open(7, { title: 'Big' });
  ctx.sent.length = 0;
  const shapes = Array.from({ length: 40 }, (_, i) => el(`b${i}`, 1, 1, { blob: 'x'.repeat(100 * 1024) }));
  ctx.session.localChange(shapes, {});
  const batches = ctx.sent.filter((s) => s.event === 'drawing:update');
  assert.ok(batches.length >= 5, `only ${batches.length} batches`);
  assert.ok(batches.every((b) => JSON.stringify(b.payload.elements).length <= 800 * 1024));
  assert.equal(updatesSent(ctx).length, 40);
});

test('new pictures are uploaded once', async () => {
  const ctx = setup();
  await ctx.session.open(7, { title: 'Pic' });
  const files = { p1: { id: 'p1', mimeType: 'image/png', dataURL: 'data:image/png;base64,QUJD' } };
  ctx.session.localChange([el('i', 1, 1, { type: 'image', fileId: 'p1' })], files);
  await ctx.advance(10);
  const uploads = ctx.calls.filter((c) => c.path === '/api/drawings/7/files');
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].body, { key: 'p1', mime: 'image/png', dataBase64: 'QUJD' });
  ctx.session.localChange([el('i', 1, 1, { type: 'image', fileId: 'p1' })], files);
  await ctx.advance(10);
  assert.equal(ctx.calls.filter((c) => c.path === '/api/drawings/7/files').length, 1, 'not uploaded twice');
});

test('a viewer uploads no pictures', async () => {
  const ctx = setup({ join: { ...GOOD_JOIN, role: 'viewer' } });
  await ctx.session.open(7, { title: 'Pic' });
  ctx.session.localChange([el('i')], { p1: { id: 'p1', mimeType: 'image/png', dataURL: 'data:image/png;base64,QUJD' } });
  await ctx.advance(10);
  assert.equal(ctx.calls.filter((c) => c.path === '/api/drawings/7/files').length, 0);
});

test('pointers are relayed at most every 30 ms, and not at all offline', async () => {
  const ctx = setup();
  await ctx.session.open(7, { title: 'Map' });
  ctx.sent.length = 0;
  for (let i = 0; i < 10; i += 1) ctx.session.pointer({ x: i, y: i });
  assert.equal(ctx.sent.filter((s) => s.event === 'drawing:pointer').length, 1);
  await ctx.advance(40);
  ctx.session.pointer({ x: 99, y: 99 });
  assert.equal(ctx.sent.filter((s) => s.event === 'drawing:pointer').length, 2);
  ctx.socket.connected = false;
  await ctx.advance(40);
  ctx.session.pointer({ x: 1, y: 1 });
  assert.equal(ctx.sent.filter((s) => s.event === 'drawing:pointer').length, 2, 'offline');
});

test('closing leaves the room, saves the local copy at once, and stops listening', async () => {
  const ctx = setup();
  await ctx.session.open(7, { title: 'Map' });
  ctx.session.localChange([el('last')], {});
  await ctx.session.close();
  assert.ok(ctx.sent.some((s) => s.event === 'drawing:leave'));
  assert.equal((await ctx.store.load(7)).elements[0].id, 'last', 'saved without waiting for the timer');
  assert.equal(ctx.handlers.size, 0, 'listeners removed');
  const count = ctx.sent.length;
  ctx.session.localChange([el('after-close')], {});
  assert.equal(ctx.sent.length, count);
});

test('refresh re-reads the connection, so the status turns to offline when the socket drops and back to saved when it returns', async () => {
  const ctx = setup();
  await ctx.session.open(7, { title: 'Map' });
  assert.equal(ctx.statuses[ctx.statuses.length - 1], 'saved');
  ctx.socket.connected = false;
  ctx.session.refresh();
  assert.equal(ctx.statuses[ctx.statuses.length - 1], 'offline');
  ctx.socket.connected = true;
  await ctx.session.reconnect();
  assert.equal(ctx.statuses[ctx.statuses.length - 1], 'saved');
});
