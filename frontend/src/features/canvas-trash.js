// IT Avenue Workspace - "Recently deleted" for personal canvases.
//
// Loaded after canvas-view.js and before renderer.js runs. Deleting a personal canvas moves it to the trash
// on the server for a few days (see backend/src/canvasTrash.js); this view lists the caller's deleted
// canvases and restores them.

const canvasTrash = (() => {
  const els = () => ({
    list: document.getElementById('canvas2-list'),
    trash: document.getElementById('canvas2-trash'),
    button: document.getElementById('btn-canvas2-trash'),
  });

  const dayText = (value) => {
    try { return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  };

  async function load() {
    const { trash } = els();
    trash.innerHTML = '<p class="canvas2-list-empty">Loading…</p>';
    try {
      const res = await api('/api/canvas/deleted');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load deleted canvases');
      const head = `<div class="canvas2-trash-head"><button type="button" class="btn" id="btn-canvas2-trash-back">← Back</button><strong>Recently deleted</strong></div>`;
      if (!data.canvases.length) {
        trash.innerHTML = head + emptyRecordMarkup('Nothing deleted', `Canvases you delete stay here for ${data.retentionDays} days.`, 'compact');
        return;
      }
      trash.innerHTML = head + data.canvases.map((c) => `
        <div class="canvas2-trash-item" data-trash-id="${c.id}">
          <strong>${escapeHtml(c.title || 'Untitled canvas')}</strong>
          ${c.preview ? `<span>${escapeHtml(c.preview.replace(/\s+/g, ' ').slice(0, 90))}</span>` : ''}
          <span>Deleted ${escapeHtml(dayText(c.deletedAt))} · restorable until ${escapeHtml(dayText(c.expiresAt))}</span>
          <button type="button" class="btn primary" data-canvas-restore="${c.id}">Restore</button>
        </div>`).join('');
    } catch (err) {
      trash.innerHTML = `<p class="canvas2-list-empty">${escapeHtml(err.message || 'Could not load deleted canvases.')}</p>`;
    }
  }

  function open() {
    const { list, trash, button } = els();
    list.hidden = true;
    trash.hidden = false;
    if (button) button.hidden = true;
    return load();
  }

  function close() {
    const { list, trash, button } = els();
    trash.hidden = true;
    list.hidden = false;
    if (button) button.hidden = false;
  }

  async function restore(id) {
    try {
      const res = await api(`/api/canvas/${id}/restore`, { method: 'POST', body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not restore the canvas');
      showToast('Canvas restored.', 'success');
      close();
      await loadCanvas2StandaloneList();
      if (typeof openCanvas2Standalone === 'function') await openCanvas2Standalone(data.canvas.id);
    } catch (err) {
      showToast(err.message || 'Could not restore the canvas.', 'error');
      load();
    }
  }

  return { open, close, restore };
})();

// Called when the owner deletes a canvas that someone else has open.
function canvasDeletedElsewhere(canvasId) {
  if (Number(canvas2StandaloneState.activeId) !== Number(canvasId)) return;
  showToast('This canvas was deleted by its owner.', 'info');
  canvas2StandaloneState.activeId = null;
  loadCanvas2StandaloneList();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    if (event.target.closest('#btn-canvas2-trash')) { canvasTrash.open(); return; }
    if (event.target.closest('#btn-canvas2-trash-back')) { canvasTrash.close(); return; }
    const restore = event.target.closest('[data-canvas-restore]');
    if (restore) canvasTrash.restore(Number(restore.dataset.canvasRestore));
  });
}
