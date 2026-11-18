// Drawings: live editing over Socket.IO.
//
// Each open drawing is a room (`drawing_<id>`) with the merged scene held in memory. People send the shapes they changed; the
// server merges them with Excalidraw's per-shape version rule (drawingMerge.js), relays what changed to the others, and saves the
// scene every few seconds while it is changing, when the last person leaves, and on shutdown. Cursors are relayed and never saved.
// Access is checked on join and again at every tick for everyone in the room, so losing access (moved out of a department,
// banned, removed from a share) drops a person within one save interval. Live rooms live in one process's memory, as the rest of
// the app already assumes.
const { requireDrawingRole, drawingAccess, loadDrawing } = require('../drawingAccess');
const { validateElements, mergeElements, MAX_ELEMENTS, MAX_SCENE_BYTES } = require('../drawingMerge');

const MAX_UPDATE_BYTES = 900 * 1024; // below Socket.IO's own 1 MB message limit, so a refusal comes from us with a reason
const POINTER_EVERY_MS = 30;
const PALETTE = ['#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#0c8599', '#c2255c', '#5f3dc4'];

const ok = (extra = {}) => ({ ok: true, ...extra });
const refusal = (err) => ({ ok: false, error: err.message || 'Something went wrong', status: err.status || 500 });

function createDrawingHub({ io, query, pool, saveEveryMs = 5000, now = Date.now }) {
  const rooms = new Map(); // drawingId -> { id, scene, revision, dirty, lastEditor, members: Map(socketId -> member), saving }
  const loading = new Map();
  const lastPointer = new Map(); // socketId -> time of the last pointer relayed
  let timer = null;

  const roomName = (id) => `drawing_${id}`;
  const presenceOf = (room) => {
    const seen = new Map();
    for (const member of room.members.values()) if (!seen.has(member.userId)) seen.set(member.userId, { userId: member.userId, username: member.username, color: member.color });
    return [...seen.values()];
  };
  const announcePresence = (room) => io.to(roomName(room.id)).emit('drawing:presence', { drawingId: room.id, present: presenceOf(room) });

  async function personColor(userId) {
    const row = (await query(
      'SELECT r.color FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.position, r.id LIMIT 1', [userId]
    )).rows[0];
    return row && /^#[0-9a-fA-F]{6}$/.test(row.color || '') ? row.color : PALETTE[userId % PALETTE.length];
  }

  async function loadRoom(id) {
    if (rooms.has(id)) return rooms.get(id);
    if (!loading.has(id)) {
      loading.set(id, (async () => {
        const row = (await query('SELECT scene, revision FROM drawings WHERE id = $1', [id])).rows[0];
        const room = { id, scene: { elements: row.scene.elements || [], appState: row.scene.appState || {} }, revision: row.revision, dirty: false, lastEditor: null, members: new Map(), saving: Promise.resolve() };
        rooms.set(id, room);
        return room;
      })().finally(() => loading.delete(id)));
    }
    return loading.get(id);
  }

  // Writes the scene if it changed. Calls are queued, so two saves never overlap.
  function flush(room) {
    room.saving = room.saving.then(async () => {
      if (!room.dirty) return;
      const scene = { elements: room.scene.elements, appState: room.scene.appState };
      if (Buffer.byteLength(JSON.stringify(scene)) > MAX_SCENE_BYTES) {
        io.to(roomName(room.id)).emit('drawing:error', { drawingId: room.id, error: 'This drawing is too large to save (the limit is 10 MB)' });
        return;
      }
      room.dirty = false;
      try {
        const saved = await query(
          'UPDATE drawings SET scene = $1, revision = revision + 1, updated_at = NOW(), updated_by = $2 WHERE id = $3 RETURNING revision',
          [JSON.stringify(scene), room.lastEditor, room.id]
        );
        if (saved.rows.length) room.revision = saved.rows[0].revision;
      } catch (err) {
        room.dirty = true;
        console.error('Save drawing error:', err);
      }
    });
    return room.saving;
  }

  async function removeMember(room, socket, { announce = true } = {}) {
    if (!room.members.delete(socket.id)) return;
    socket.leave(roomName(room.id));
    lastPointer.delete(socket.id);
    if (room.members.size === 0) {
      await flush(room);
      if (rooms.get(room.id) === room && room.members.size === 0) rooms.delete(room.id);
    } else if (announce) {
      announcePresence(room);
    }
  }

  const memberOf = (socket, drawingId) => {
    const room = rooms.get(drawingId);
    const member = room ? room.members.get(socket.id) : null;
    return member ? { room, member } : null;
  };
  const parseDrawingId = (payload) => (payload && /^\d+$/.test(String(payload.drawingId)) ? Number(payload.drawingId) : null);

  function register(socket) {
    socket.on('drawing:join', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const userId = socket.data && socket.data.userId;
        if (!userId) return reply({ ok: false, error: 'Sign in first', status: 401 });
        const drawingId = parseDrawingId(payload);
        if (!drawingId) return reply({ ok: false, error: 'A valid drawing is required', status: 400 });
        const { role, readOnlyReason } = await requireDrawingRole(query, userId, drawingId, 'viewer');
        const room = await loadRoom(drawingId);
        const person = (await query('SELECT username FROM users WHERE id = $1', [userId])).rows[0];
        room.members.set(socket.id, { socket, userId, username: person ? person.username : 'Someone', color: await personColor(userId), role, readOnlyReason });
        socket.join(roomName(drawingId));
        const files = (await query('SELECT file_key, mime FROM drawing_files WHERE drawing_id = $1 ORDER BY file_key', [drawingId])).rows;
        announcePresence(room);
        return reply(ok({
          scene: room.scene, files: files.map((file) => ({ key: file.file_key, mime: file.mime })), revision: room.revision,
          role, readOnlyReason, present: presenceOf(room),
        }));
      } catch (err) {
        return reply(refusal(err));
      }
    });

    socket.on('drawing:update', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const drawingId = parseDrawingId(payload);
        const joined = drawingId ? memberOf(socket, drawingId) : null;
        if (!joined) return reply({ ok: false, error: 'Open the drawing first', status: 403 });
        if (joined.member.role !== 'editor') return reply({ ok: false, error: 'This drawing is view-only for you', status: 403 });
        const elements = validateElements(payload.elements);
        if (Buffer.byteLength(JSON.stringify(elements)) > MAX_UPDATE_BYTES) return reply({ ok: false, error: 'That update is too large; send fewer shapes at a time', status: 400 });
        const merged = mergeElements(joined.room.scene.elements, elements);
        if (merged.elements.length > MAX_ELEMENTS) return reply({ ok: false, error: `Too many shapes: a drawing can hold at most ${MAX_ELEMENTS}`, status: 400 });
        if (merged.changed.length) {
          joined.room.scene.elements = merged.elements;
          joined.room.dirty = true;
          joined.room.lastEditor = joined.member.userId;
          socket.to(roomName(drawingId)).emit('drawing:update', { drawingId, elements: merged.changed, from: joined.member.userId });
        }
        return reply(ok({ applied: merged.changed.length }));
      } catch (err) {
        return reply(refusal(err));
      }
    });

    socket.on('drawing:pointer', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const drawingId = parseDrawingId(payload);
      const joined = drawingId ? memberOf(socket, drawingId) : null;
      if (!joined || !payload.pointer || typeof payload.pointer !== 'object') return reply({ ok: false });
      const last = lastPointer.get(socket.id) || 0;
      if (now() - last < POINTER_EVERY_MS) return reply(ok({ dropped: true }));
      const { x, y, tool, button } = payload.pointer;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return reply({ ok: false });
      lastPointer.set(socket.id, now());
      const pointer = { x, y };
      if (typeof tool === 'string') pointer.tool = tool.slice(0, 20);
      if (typeof button === 'string') pointer.button = button.slice(0, 10);
      socket.to(roomName(drawingId)).emit('drawing:pointer', {
        drawingId, pointer, userId: joined.member.userId, username: joined.member.username, color: joined.member.color,
      });
      return reply(ok());
    });

    socket.on('drawing:leave', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const drawingId = parseDrawingId(payload);
      const joined = drawingId ? memberOf(socket, drawingId) : null;
      if (joined) await removeMember(joined.room, socket);
      return reply(ok());
    });

    socket.on('disconnect', async () => {
      for (const room of [...rooms.values()]) if (room.members.has(socket.id)) await removeMember(room, socket);
    });
  }

  // One save interval: re-check everyone's access, then save what changed.
  async function tick() {
    for (const room of [...rooms.values()]) {
      let drawing;
      try {
        drawing = await loadDrawing(query, room.id);
      } catch (err) {
        if (err.status === 404) { // the drawing was deleted while open
          for (const member of [...room.members.values()]) { member.socket.leave(roomName(room.id)); lastPointer.delete(member.socket.id); }
          room.members.clear();
          rooms.delete(room.id);
          continue;
        }
        console.error('Drawing tick error:', err);
        continue;
      }
      let evicted = false;
      for (const member of [...room.members.values()]) {
        const access = await drawingAccess(query, member.userId, drawing);
        if (!access.role) {
          member.socket.emit('drawing:revoked', { drawingId: room.id });
          room.members.delete(member.socket.id);
          member.socket.leave(roomName(room.id));
          lastPointer.delete(member.socket.id);
          evicted = true;
        } else if (access.role !== member.role || access.readOnlyReason !== member.readOnlyReason) {
          member.role = access.role;
          member.readOnlyReason = access.readOnlyReason;
          member.socket.emit('drawing:role', { drawingId: room.id, role: access.role, readOnlyReason: access.readOnlyReason });
        }
      }
      if (evicted && room.members.size) announcePresence(room);
      await flush(room);
      if (room.members.size === 0) rooms.delete(room.id);
    }
  }

  async function flushAll() {
    await Promise.all([...rooms.values()].map((room) => flush(room)));
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((err) => console.error('Drawing tick failed:', err)); }, saveEveryMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function shutdown() {
    if (timer) { clearInterval(timer); timer = null; }
    await flushAll();
  }

  return { register, tick, flushAll, start, shutdown, pool };
}

module.exports = { createDrawingHub, MAX_UPDATE_BYTES };
