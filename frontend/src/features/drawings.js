// IT Avenue Workspace - drawings: the screens (list, editor, share dialog) and how they connect to the live session.
//
// Markup comes from drawing-view.js; the live session, the local copy and the sync rules from drawing-session.js,
// drawing-store.js and drawing-sync.js; the editor itself (Excalidraw) from vendor/drawing-editor.js, which is loaded the first
// time a drawing is opened so it does not slow the app's start. Loaded before renderer.js, which calls setupDrawings().

const drawingsState = {
  scope: 'mine', // 'mine' | 'shared'
  store: null,
  open: null, // { id, drawing, role, ... } while a drawing is open
  session: null,
  handle: null,
  status: 'saved',
  statusText: 'Saved',
  present: [],
  editorReady: null,
  share: null,
};

function drawingStoreInstance() {
  if (!drawingsState.store) {
    drawingsState.store = createDrawingStore(typeof indexedDB !== 'undefined' ? indexedDbDrawingBackend() : memoryDrawingBackend());
  }
  return drawingsState.store;
}

const drawingIsDraft = (id) => String(id).startsWith('local-');

// Loads the editor script and its stylesheet once, from the app's own files.
function ensureDrawingEditor() {
  if (window.ITADrawing) return Promise.resolve();
  if (!drawingsState.editorReady) {
    drawingsState.editorReady = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'vendor/drawing-assets/excalidraw.css';
      document.head.appendChild(link);
      const script = document.createElement('script');
      script.src = 'vendor/drawing-editor.js';
      script.onload = () => resolve();
      script.onerror = () => { drawingsState.editorReady = null; reject(new Error('The drawing editor could not be loaded')); };
      document.head.appendChild(script);
    });
  }
  return drawingsState.editorReady;
}

async function drawingJson(path, options) {
  const response = await api(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: response.status });
  return data;
}

function drawingWithTimes(list) {
  return list.map((drawing) => ({ ...drawing, updatedText: forumRelativeTime(drawing.updatedAt || drawing.createdAt) }));
}

// ---------------------------------------------------------------------------------------------------------- the list
async function loadDrawingsList() {
  const host = document.getElementById('drawings-list');
  if (!host) return;
  const offlineNote = document.getElementById('drawings-offline');
  document.querySelectorAll('[data-drawings-scope]').forEach((tab) => {
    const on = tab.dataset.drawingsScope === drawingsState.scope;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-pressed', String(on));
  });
  let drawings; let offline = false;
  try {
    drawings = (await drawingJson(`/api/drawings?scope=${drawingsState.scope}`)).drawings;
  } catch (err) {
    offline = true;
    drawings = [];
  }
  const local = await drawingStoreInstance().list().catch(() => []);
  if (drawingsState.scope === 'mine') {
    const known = new Set(drawings.map((drawing) => String(drawing.id)));
    for (const record of local) {
      if (record.kind !== 'standalone' || known.has(record.id) || (!offline && !drawingIsDraft(record.id))) continue;
      drawings.push({ id: record.id, title: record.title, ownerUsername: state.user && state.user.username, role: 'editor', readOnlyReason: null, updatedAt: new Date(record.updatedAt).toISOString() });
    }
  }
  if (offlineNote) offlineNote.hidden = !offline;
  host.innerHTML = drawingListHtml(drawingWithTimes(drawings), {
    empty: drawingsState.scope === 'mine' ? 'No drawings yet. Press New drawing to start one.' : 'Nothing has been shared with you yet.',
  });
}

async function showDrawingsHome() {
  if (drawingsState.open) return; // a drawing is open: leave it as it is
  document.getElementById('drawings-home').hidden = false;
  document.getElementById('drawings-editor').hidden = true;
  await loadDrawingsList();
}

// ------------------------------------------------------------------------------------------------------ the open drawing
function renderDrawingBar() {
  const host = document.getElementById('drawing-bar-host');
  const open = drawingsState.open;
  if (!host || !open) return;
  const mine = Number(open.drawing.ownerId) === Number(state.user && state.user.id);
  host.innerHTML = drawingBarHtml({
    drawing: open.drawing, status: drawingsState.status, statusText: drawingsState.statusText, present: drawingsState.present,
    canShare: open.drawing.kind === 'standalone' && mine && !drawingIsDraft(open.id),
    canDelete: !drawingIsDraft(open.id) && (mine || (open.drawing.channelId && canModerateChannel(open.drawing.channelId))),
  });
}

async function fetchDrawingPicture(drawingId, key) {
  const response = await fetch(`${API_BASE}/api/drawings/${drawingId}/files/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!response.ok) return null;
  const blob = await response.blob();
  const dataURL = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
  return { id: key, mimeType: blob.type || 'image/png', dataURL, created: Date.now() };
}

async function openDrawing(id) {
  await ensureDrawingEditor().catch((err) => { showToast(err.message, 'error'); throw err; });
  if (drawingsState.open) await closeDrawing();
  const store = drawingStoreInstance();
  const local = await store.load(id);
  let server = null;
  if (!drawingIsDraft(id)) {
    try { server = await drawingJson(`/api/drawings/${id}`); } catch (err) {
      if (err.status === 403 || err.status === 404) { showToast(err.status === 404 ? 'This drawing no longer exists.' : 'You do not have access to this drawing.', 'error'); if (!local) return; }
    }
  }
  if (!server && !local) { showToast('This drawing is not available offline.', 'error'); return; }
  const drawing = server ? server.drawing : {
    id, title: local.title, kind: local.kind || 'standalone', channelId: local.channelId ?? null, topicId: local.topicId ?? null,
    ownerId: state.user && state.user.id, role: local.role || 'editor', readOnlyReason: null,
  };
  const initialElements = mergeElementsLocal(local ? local.elements : [], server ? server.scene.elements : []);
  drawingsState.open = { id, drawing };
  drawingsState.present = [];
  document.getElementById('drawings-home').hidden = true;
  document.getElementById('drawings-editor').hidden = false;
  const canvas = document.getElementById('drawing-canvas');
  canvas.innerHTML = '';
  renderDrawingBar();

  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const handle = ITADrawing.mount(canvas, {
    initialElements, initialFiles: (local && local.files) || {}, viewOnly: drawing.role !== 'editor', title: drawing.title,
    onChange: (elements, files) => { if (drawingsState.session) drawingsState.session.localChange(elements, files); },
    onPointer: (pointer) => { if (drawingsState.session) drawingsState.session.pointer(pointer.pointer ? { ...pointer.pointer, tool: pointer.pointer.tool || pointer.tool, button: pointer.button } : null); },
    onReady: ready,
  });
  drawingsState.handle = handle;
  await readyPromise;
  const session = createDrawingSession({
    store, socket: state.socket, api, editor: handle,
    onStatus: (status, text) => { drawingsState.status = status; drawingsState.statusText = text; renderDrawingBar(); },
    onPresence: (list) => { drawingsState.present = list; renderDrawingBar(); },
    onIdChanged: (newId) => { if (drawingsState.open) { drawingsState.open.id = newId; drawingsState.open.drawing = { ...drawingsState.open.drawing, id: newId }; renderDrawingBar(); } },
    onNotice: handleDrawingNotice,
    onMissingFiles: async (keys) => {
      const pictures = (await Promise.all(keys.map((key) => fetchDrawingPicture(drawingsState.open && drawingsState.open.id, key).catch(() => null)))).filter(Boolean);
      if (pictures.length && drawingsState.handle) drawingsState.handle.addFiles(pictures);
    },
  });
  drawingsState.session = session;
  await session.open(id, { title: drawing.title, kind: drawing.kind, channelId: drawing.channelId, topicId: drawing.topicId });
  if (server) drawingsState.open.drawing = { ...drawing, role: session.state().role || drawing.role, readOnlyReason: server.readOnlyReason };
  renderDrawingBar();
}

async function handleDrawingNotice(notice) {
  if (!drawingsState.open) return;
  if (notice.type === 'deleted') {
    const save = await confirmAction({ title: 'This drawing was deleted', message: 'Your copy is still on this computer. Save it as a drawing of your own?', confirmLabel: 'Save as my own', cancelLabel: 'Not now', danger: false });
    if (save && drawingsState.session) {
      try { await drawingsState.session.saveAsOwn(); showToast('Saved as a drawing of your own.', 'success'); } catch (err) { showToast(err.message || 'Could not save it.', 'error'); }
    }
  } else if (notice.type === 'revoked' || notice.type === 'denied') {
    showToast('You can no longer reach this drawing. Your changes stay on this computer.', 'error');
  } else if (notice.type === 'role') {
    drawingsState.open.drawing = { ...drawingsState.open.drawing, role: notice.role, readOnlyReason: notice.readOnlyReason };
    renderDrawingBar();
  } else if (notice.type === 'error') {
    showToast(notice.error || 'Something went wrong with this drawing.', 'error');
  }
}

async function closeDrawing() {
  const session = drawingsState.session;
  const handle = drawingsState.handle;
  drawingsState.session = null; drawingsState.handle = null; drawingsState.open = null; drawingsState.present = [];
  if (session) await session.close().catch(() => {});
  if (handle) handle.destroy();
  const canvas = document.getElementById('drawing-canvas');
  if (canvas) canvas.innerHTML = '';
  document.getElementById('drawings-editor').hidden = true;
  document.getElementById('drawings-home').hidden = false;
  await loadDrawingsList();
}

// ------------------------------------------------------------------------------------------------------- creating drawings
// A standalone drawing (no channel), or one in the current channel or forum topic with its card posted into the conversation.
async function startNewDrawing({ channelId = null, topicId = null } = {}) {
  const asked = await askText('Name this drawing', { placeholder: 'Untitled drawing', maxLength: 120 });
  if (asked === null) return;
  const title = asked.trim() || 'Untitled drawing';
  try {
    if (channelId || state.socket?.connected) {
      const created = await drawingJson('/api/drawings', { method: 'POST', body: JSON.stringify({ title, ...(channelId ? { channelId, topicId } : {}) }) });
      await setSection('drawings');
      await openDrawing(created.drawing.id);
      return;
    }
    // offline: a draft on this computer, created on the server at the first sync
    const id = `local-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    await drawingStoreInstance().save(id, { title, kind: 'standalone', channelId: null, topicId: null, elements: [], files: {}, lastRevision: 0, dirty: true, role: 'editor' });
    await setSection('drawings');
    await openDrawing(id);
  } catch (err) {
    showToast(err.message || 'Could not start the drawing.', 'error');
  }
}

async function addDrawingToConversation() {
  const channelId = state.currentChannelId;
  const target = typeof forumSendTarget === 'function' ? forumSendTarget() : { topicId: null, blocked: false };
  if (!channelId) return;
  if (target.blocked) { showToast('Open a topic first, then add a drawing to it.', 'info'); return; }
  if (!state.socket?.connected) { showToast('Adding a drawing to a conversation needs a connection. You can draw on your own while offline from Drawings.', 'info'); return; }
  await startNewDrawing({ channelId: Number(channelId), topicId: target.topicId });
}

// ---------------------------------------------------------------------------------------------------- rename, export, delete
async function renameOpenDrawing() {
  const open = drawingsState.open;
  if (!open) return;
  const title = await askText('New title', { placeholder: open.drawing.title, maxLength: 120, required: true });
  if (title === null || !title.trim() || title.trim() === open.drawing.title) return;
  try {
    if (!drawingIsDraft(open.id)) await drawingJson(`/api/drawings/${open.id}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) });
    open.drawing = { ...open.drawing, title: title.trim() };
    renderDrawingBar();
  } catch (err) { showToast(err.message || 'Could not rename it.', 'error'); }
}

function downloadDrawingFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportOpenDrawing(format) {
  const open = drawingsState.open;
  if (!open || !drawingsState.handle) return;
  const base = String(open.drawing.title || 'drawing').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'drawing';
  try {
    if (format === 'svg') downloadDrawingFile(new Blob([await drawingsState.handle.exportSvg()], { type: 'image/svg+xml' }), `${base}.svg`);
    else downloadDrawingFile(await drawingsState.handle.exportPng(), `${base}.png`);
  } catch (err) { showToast(err.message || 'Could not export the drawing.', 'error'); }
}

async function deleteOpenDrawing() {
  const open = drawingsState.open;
  if (!open) return;
  if (!(await confirmAction({ title: 'Delete this drawing?', message: 'It is removed for everyone. This cannot be undone.', confirmLabel: 'Delete drawing' }))) return;
  try {
    await drawingJson(`/api/drawings/${open.id}`, { method: 'DELETE' });
    await drawingStoreInstance().remove(open.id);
    await closeDrawing();
    showToast('Drawing deleted.', 'success');
  } catch (err) { showToast(err.message || 'Could not delete it.', 'error'); }
}

// ---------------------------------------------------------------------------------------------------------- the Share dialog
async function openDrawingShare() {
  const open = drawingsState.open;
  const modal = document.getElementById('drawing-share-modal');
  if (!open || !modal) return;
  try {
    const data = await drawingJson(`/api/drawings/${open.id}`);
    const people = (state.users || []).filter((user) => Number(user.id) !== Number(state.user.id));
    drawingsState.share = { people: employeeOptions(people.map((user) => ({ id: user.id, name: personName(user), username: user.username }))) };
    const channels = (state.channels || []).filter((channel) => !channel.isPersonal && !channel.archivedAt && channel.kind !== 'personal');
    modal.innerHTML = drawingShareHtml({ drawing: data.drawing, members: data.members || [], people: drawingsState.share.people.map((p) => p.label), channels });
    openSettingsModal(modal);
  } catch (err) { showToast(err.message || 'Could not open sharing.', 'error'); }
}

async function handleDrawingShareClick(event) {
  const open = drawingsState.open;
  const modal = document.getElementById('drawing-share-modal');
  if (!open || !modal) return;
  const target = event.target;
  try {
    if (target.closest('[data-drawing-share-close]')) { closeSettingsModal(); return; }
    const remove = target.closest('[data-drawing-member-remove]');
    if (remove) { await drawingJson(`/api/drawings/${open.id}/members/${Number(remove.dataset.drawingMemberRemove)}`, { method: 'DELETE' }); await openDrawingShare(); return; }
    if (target.closest('[data-drawing-add]')) {
      const id = headIdFromInput(modal.querySelector('[data-drawing-add-person]').value, drawingsState.share.people);
      if (!id) { showToast('Pick the person from the list.', 'error'); return; }
      await drawingJson(`/api/drawings/${open.id}/members/${id}`, { method: 'PUT', body: JSON.stringify({ role: modal.querySelector('[data-drawing-add-role]').value }) });
      await openDrawingShare();
      return;
    }
    if (target.closest('[data-drawing-copy]')) {
      const channelSelect = modal.querySelector('[data-drawing-copy-channel]');
      const topicSelect = modal.querySelector('[data-drawing-copy-topic]');
      if (!channelSelect.value) { showToast('Choose a channel first.', 'info'); return; }
      const body = { channelId: Number(channelSelect.value) };
      if (!topicSelect.hidden) { if (!topicSelect.value) { showToast('Choose a topic.', 'info'); return; } body.topicId = Number(topicSelect.value); }
      await drawingJson(`/api/drawings/${open.id}/share`, { method: 'POST', body: JSON.stringify(body) });
      showToast('A copy was added to the conversation.', 'success');
    }
  } catch (err) { showToast(err.message || 'That did not work.', 'error'); }
}

async function handleDrawingShareChange(event) {
  const open = drawingsState.open;
  const modal = document.getElementById('drawing-share-modal');
  if (!open || !modal) return;
  const roleSelect = event.target.closest('[data-drawing-member-role]');
  try {
    if (roleSelect) {
      await drawingJson(`/api/drawings/${open.id}/members/${Number(roleSelect.dataset.drawingMemberRole)}`, { method: 'PUT', body: JSON.stringify({ role: roleSelect.value }) });
      return;
    }
    if (event.target.closest('[data-drawing-copy-channel]')) {
      const select = event.target;
      const topicSelect = modal.querySelector('[data-drawing-copy-topic]');
      const forum = select.selectedOptions[0] && select.selectedOptions[0].dataset.forum === '1';
      topicSelect.hidden = !forum;
      if (forum) {
        const data = await drawingJson(`/api/forums/${select.value}/topics`);
        topicSelect.innerHTML = `<option value="">Choose a topic</option>${data.topics.filter((topic) => !topic.lockedAt && !topic.archivedAt).map((topic) => `<option value="${Number(topic.id)}">${escapeHtml(topic.title)}</option>`).join('')}`;
      }
    }
  } catch (err) { showToast(err.message || 'That did not work.', 'error'); }
}

// ------------------------------------------------------------------------------------------------------------- wiring
function setupDrawings() {
  installMermaidTemplates();
  document.addEventListener('click', (event) => {
    const target = event.target;
    const opener = target.closest && target.closest('[data-drawing-open]');
    if (opener) {
      const id = opener.dataset.drawingOpen;
      (async () => { await setSection('drawings'); await openDrawing(/^\d+$/.test(id) ? Number(id) : id); })();
      return;
    }
    if (!target.closest) return;
    if (target.closest('#btn-drawings-new')) { startNewDrawing(); return; }
    if (target.closest('#btn-add-drawing')) { addDrawingToConversation(); return; }
    if (target.closest('[data-drawing-new-channel]')) { addDrawingToConversation(); return; }
    const scope = target.closest('[data-drawings-scope]');
    if (scope) { drawingsState.scope = scope.dataset.drawingsScope; loadDrawingsList(); return; }
    if (target.closest('[data-drawing-back]')) { closeDrawing(); return; }
    if (target.closest('[data-drawing-rename]')) { renameOpenDrawing(); return; }
    const exportButton = target.closest('[data-drawing-export]');
    if (exportButton) { exportOpenDrawing(exportButton.dataset.drawingExport); return; }
    if (target.closest('[data-drawing-share]')) { openDrawingShare(); return; }
    if (target.closest('[data-drawing-delete]')) { deleteOpenDrawing(); return; }
  });
  const modal = document.getElementById('drawing-share-modal');
  if (modal) { modal.addEventListener('click', handleDrawingShareClick); modal.addEventListener('change', handleDrawingShareChange); }
}

// After the socket exists: reconnect and connection changes keep the open drawing in step.
// The server only accepts a join once the socket has signed in again, so a reconnect waits for 'authenticated', not 'connect'.
function setupDrawingSocketEvents() {
  state.socket.on('authenticated', () => { if (drawingsState.session) drawingsState.session.reconnect(); });
  state.socket.on('disconnect', () => { if (drawingsState.session) drawingsState.session.refresh(); });
}
