// IT Avenue Workspace - drawings: the live session of one open drawing.
//
// It keeps a copy on this computer as you draw, sends what you change to the server while online, applies what others draw, and
// after a time offline merges the server's version with yours and sends only what differs. It never touches the page: it talks to
// a socket, to `api` (the app's fetch helper), to the `editor` handle (see editor-src/drawing-editor.js) and to the store, all of
// which are passed in, so it is tested with fakes. A draft made offline (id "local-...") is created on the server at first sync.
//
//   const session = createDrawingSession({ store, socket, api, editor, onStatus, onNotice, onIdChanged, onPresence, onMissingFiles });
//   await session.open(id, { title, kind, channelId, topicId });
//   session.localChange(elements, files);   // on every editor change
//   session.pointer({ x, y, tool });        // on pointer movement
//   await session.reconnect();              // when the socket connects again
//   await session.close();

const DRAWING_LOCAL_SAVE_MS = 1000;
const DRAWING_BATCH_BYTES = 800 * 1024; // under the server's 900 KB cap for one update
const DRAWING_POINTER_MS = 30;
const DRAWING_JOIN_TIMEOUT_MS = 10000;
const DRAWING_EVENTS = ['drawing:update', 'drawing:presence', 'drawing:pointer', 'drawing:role', 'drawing:revoked', 'drawing:removed', 'drawing:error'];

function createDrawingSession({
  store, socket, api, editor,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
  now = Date.now,
  onStatus = () => {}, onNotice = () => {}, onIdChanged = () => {}, onPresence = () => {}, onMissingFiles = () => {},
}) {
  let id = null;
  let meta = { title: 'Drawing', kind: 'standalone', channelId: null, topicId: null };
  let current = { elements: [], files: {} };
  let known = new Map(); // shapes the server has: id -> { id, version, versionNonce }
  let uploaded = new Set(); // picture keys the server has
  const uploading = new Set();
  const collaborators = new Map();
  let role = 'editor';
  let joined = false; let denied = false; let dirty = false; let closed = false; let pending = 0;
  let lastRevision = 0; let lastPointer = -Infinity; let lastStatus = null; let saveTimer = null;

  const isDraft = () => String(id).startsWith('local-');
  const online = () => Boolean(socket.connected);
  const liveElements = () => {
    const fromEditor = editor && typeof editor.getElements === 'function' ? editor.getElements() : null;
    return Array.isArray(fromEditor) && (fromEditor.length || !current.elements.length) ? fromEditor : current.elements;
  };

  function report() {
    const status = syncStatus({ online: online(), dirty, saving: pending > 0, denied });
    if (status !== lastStatus) { lastStatus = status; onStatus(status, syncStatusText(status)); }
  }

  const knownList = () => [...known.values()];
  const remember = (shapes) => { for (const shape of shapes) known.set(shape.id, { id: shape.id, version: shape.version, versionNonce: shape.versionNonce }); };

  async function saveLocalNow() {
    if (saveTimer !== null) { timers.clear(saveTimer); saveTimer = null; }
    if (id === null || (!dirty && !current.elements.length)) return;
    await store.save(id, { title: meta.title, kind: meta.kind, channelId: meta.channelId, topicId: meta.topicId, elements: current.elements, files: current.files, lastRevision, dirty });
  }
  function scheduleLocalSave() {
    if (saveTimer !== null) timers.clear(saveTimer);
    saveTimer = timers.set(() => { saveTimer = null; saveLocalNow(); }, DRAWING_LOCAL_SAVE_MS);
  }

  // The server needs a drawing before it can take shapes. A draft made offline, or a drawing deleted while you were away, is
  // created as a new standalone drawing from the local copy; its local record moves to the new id.
  async function createOnServer() {
    const elements = liveElements();
    const files = Object.values(current.files || {}).filter((file) => file && file.dataURL).map((file) => ({
      key: file.id, mime: file.mimeType, dataBase64: String(file.dataURL).split(',')[1] || '',
    }));
    const response = await api('/api/drawings', { method: 'POST', body: JSON.stringify({ title: meta.title, scene: { elements, appState: {} }, files }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not create the drawing on the server');
    const newId = data.drawing.id;
    current = { elements, files: current.files };
    await store.save(id, { title: meta.title, kind: 'standalone', channelId: null, topicId: null, elements, files: current.files, lastRevision, dirty });
    await store.rename(id, newId);
    id = newId;
    meta = { ...meta, kind: 'standalone', channelId: null, topicId: null };
    uploaded = new Set(files.map((file) => file.key));
    known = new Map();
    remember(elements);
    onIdChanged(newId);
    return newId;
  }

  function joinOnServer() {
    return new Promise((resolve) => {
      let finished = false;
      const timeout = timers.set(() => { if (!finished) { finished = true; resolve({ ok: false, error: 'The server did not answer', status: 0 }); } }, DRAWING_JOIN_TIMEOUT_MS);
      socket.emit('drawing:join', { drawingId: Number(id) }, (answer) => {
        if (finished) return;
        finished = true;
        timers.clear(timeout);
        resolve(answer || { ok: false, error: 'No answer', status: 0 });
      });
    });
  }

  async function sendBatches(shapes) {
    for (const batch of chunkElements(shapes, DRAWING_BATCH_BYTES)) {
      pending += 1;
      report();
      socket.emit('drawing:update', { drawingId: Number(id), elements: batch }, (answer) => {
        pending -= 1;
        if (answer && answer.ok) {
          remember(batch);
          if (pending === 0 && !elementsToSend(liveElements(), knownList()).length) { dirty = false; scheduleLocalSave(); }
        } else if (answer && (answer.status === 403 || answer.status === 401)) {
          denied = true;
        }
        report();
      });
    }
  }

  // Sends what the server does not have yet (new shapes, newer versions, deletions).
  function pushLocal() {
    if (!joined || denied || !online() || role !== 'editor') return;
    const shapes = elementsToSend(liveElements(), knownList());
    if (!shapes.length) { dirty = false; report(); return; }
    sendBatches(shapes);
  }

  async function uploadNewPictures(files) {
    const fresh = Object.values(files || {}).filter((file) => file && file.dataURL && !uploaded.has(file.id) && !uploading.has(file.id));
    for (const file of fresh) {
      uploading.add(file.id);
      try {
        const response = await api(`/api/drawings/${id}/files`, { method: 'POST', body: JSON.stringify({ key: file.id, mime: file.mimeType, dataBase64: String(file.dataURL).split(',')[1] || '' }) });
        if (response.ok) uploaded.add(file.id);
      } catch (err) { /* retried at the next change */ } finally { uploading.delete(file.id); }
    }
  }

  const newPictureKeys = (files) => Object.values(files || {}).filter((file) => file && file.dataURL && !uploaded.has(file.id) && !uploading.has(file.id));

  async function syncOnline() {
    if (closed) return;
    if (isDraft()) {
      try { await createOnServer(); } catch (err) { onNotice({ type: 'error', error: err.message }); report(); return; }
    }
    const answer = await joinOnServer();
    if (!answer.ok) {
      joined = false;
      if (answer.status === 404) { denied = true; onNotice({ type: 'deleted' }); }
      else if (answer.status === 403 || answer.status === 401) { denied = true; onNotice({ type: 'denied', error: answer.error }); }
      report();
      return;
    }
    denied = false; joined = true;
    role = answer.role;
    if (editor && editor.setViewOnly) editor.setViewOnly(role !== 'editor');
    lastRevision = answer.revision;
    known = new Map();
    remember(answer.scene.elements || []);
    uploaded = new Set((answer.files || []).map((file) => file.key));
    if ((answer.scene.elements || []).length) editor.updateElements(answer.scene.elements);
    current = { elements: liveElements(), files: current.files };
    onPresence(answer.present || []);
    const missing = uploaded.size ? [...uploaded].filter((key) => !current.files[key]) : [];
    if (missing.length) onMissingFiles(missing);
    if (role === 'editor') {
      await uploadNewPictures(current.files);
      pushLocal();
    }
    scheduleLocalSave();
    report();
  }

  const forThisDrawing = (payload) => payload && Number(payload.drawingId) === Number(id);
  const handlers = {
    'drawing:update': (payload) => {
      if (!forThisDrawing(payload)) return;
      remember(payload.elements);
      editor.updateElements(payload.elements);
      current = { elements: liveElements(), files: current.files };
      scheduleLocalSave();
    },
    'drawing:presence': (payload) => {
      if (!forThisDrawing(payload)) return;
      const here = new Set(payload.present.map((person) => String(person.userId)));
      for (const key of [...collaborators.keys()]) if (!here.has(key)) collaborators.delete(key);
      editor.setCollaborators([...collaborators.values()]);
      onPresence(payload.present);
    },
    'drawing:pointer': (payload) => {
      if (!forThisDrawing(payload)) return;
      collaborators.set(String(payload.userId), { id: payload.userId, username: payload.username, color: payload.color, pointer: payload.pointer });
      editor.setCollaborators([...collaborators.values()]);
    },
    'drawing:role': (payload) => {
      if (!forThisDrawing(payload)) return;
      role = payload.role;
      editor.setViewOnly(role !== 'editor');
      onNotice({ type: 'role', role: payload.role, readOnlyReason: payload.readOnlyReason });
    },
    'drawing:revoked': (payload) => {
      if (!forThisDrawing(payload)) return;
      denied = true; joined = false;
      onNotice({ type: 'revoked' });
      report();
    },
    'drawing:removed': (payload) => {
      if (!forThisDrawing(payload)) return;
      denied = true; joined = false;
      onNotice({ type: 'deleted' });
      report();
    },
    'drawing:error': (payload) => { if (forThisDrawing(payload)) onNotice({ type: 'error', error: payload.error }); },
  };

  return {
    // Starts working on a drawing. The editor is already showing the local (or server) copy; this connects it.
    async open(drawingId, options = {}) {
      id = drawingId;
      closed = false;
      const local = await store.load(id);
      meta = { title: options.title || (local && local.title) || 'Drawing', kind: options.kind || (local && local.kind) || 'standalone', channelId: options.channelId ?? (local && local.channelId) ?? null, topicId: options.topicId ?? (local && local.topicId) ?? null };
      if (local) { current = { elements: local.elements, files: local.files || {} }; lastRevision = local.lastRevision || 0; dirty = Boolean(local.dirty); }
      for (const event of DRAWING_EVENTS) socket.on(event, handlers[event]);
      if (online()) await syncOnline(); else report();
    },

    // After every editor change: keep a copy here, and send it if connected.
    localChange(elements, files) {
      if (closed) return;
      current = { elements, files: files || {} };
      if (joined && role !== 'editor') return;
      dirty = true;
      scheduleLocalSave();
      report();
      if (!joined || denied || !online()) return;
      if (newPictureKeys(files).length) uploadNewPictures(files).then(pushLocal);
      else pushLocal();
    },

    pointer(pointer) {
      if (closed || !joined || !online() || !pointer) return;
      const time = now();
      if (time - lastPointer < DRAWING_POINTER_MS) return;
      lastPointer = time;
      socket.emit('drawing:pointer', { drawingId: Number(id), pointer: { x: pointer.x, y: pointer.y, tool: pointer.tool, button: pointer.button } });
    },

    // The socket is back: merge the server's version with ours and send what differs.
    async reconnect() {
      if (closed || id === null) return;
      denied = false;
      await syncOnline();
    },

    // The drawing was deleted (or you lost it): keep the local copy as a new drawing of your own.
    async saveAsOwn() {
      const newId = await createOnServer();
      denied = false;
      await syncOnline();
      return newId;
    },

    async close() {
      if (closed) return;
      closed = true;
      await saveLocalNow();
      if (joined && online()) socket.emit('drawing:leave', { drawingId: Number(id) }, () => {});
      joined = false;
      for (const event of DRAWING_EVENTS) socket.off(event, handlers[event]);
    },

    state: () => ({ id, status: lastStatus, role, joined, denied, dirty, lastRevision }),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  const sync = require('./drawing-sync');
  // the browser loads drawing-sync.js first and shares its functions; in Node they are required
  Object.assign(globalThis, { elementsToSend: sync.elementsToSend, chunkElements: sync.chunkElements, syncStatus: sync.syncStatus, syncStatusText: sync.syncStatusText });
  module.exports = { createDrawingSession };
}
