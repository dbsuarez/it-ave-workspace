// IT Avenue Workspace - Canvas: Read/Edit toggle, interactive checklists, and version history.
//
// Loaded before renderer.js (functions only; renderer.js calls canvasViewOpened / canvasViewRefresh).
// Read mode shows the rendered canvas (features/canvas-render.js) built from the server's sections;
// ticking a checklist box sends one `toggle` section operation, checked against the canvas revision, so
// it can never overwrite someone else's change. Edit mode is the Markdown textarea with autosave.

const canvasViews = {
  sheet: {
    mode: 'edit', revision: null,
    id: () => canvas2State.activeId,
    state: () => canvas2State,
    editor: () => els.canvasSheetEditor,
    title: () => els.canvasSheetTitle,
    render: () => document.getElementById('canvas-sheet-render'),
    modeButton: () => document.getElementById('btn-canvas-sheet-mode'),
    save: () => saveCanvas2(),
    flush: () => clearTimeout(canvas2State.saveTimer),
    saving: () => canvas2State.saving,
    canEdit: true,
  },
  standalone: {
    mode: 'edit', revision: null,
    id: () => canvas2StandaloneState.activeId,
    state: () => canvas2StandaloneState,
    editor: () => document.getElementById('canvas2-editor'),
    title: () => document.getElementById('canvas2-editor-title'),
    render: () => document.getElementById('canvas2-render'),
    modeButton: () => document.getElementById('btn-canvas2-mode'),
    save: () => saveCanvas2Standalone(),
    flush: () => clearTimeout(canvas2StandaloneState.saveTimer),
    saving: () => canvas2StandaloneState.saving,
    canEdit: true,
  },
};

const cvwSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pictures live behind the sign-in, so they are fetched with the token and shown from a blob URL.
const cvwImageUrls = new Map(); // file id -> blob URL (kept while the app runs; they are small)

async function cvwLoadImages(container) {
  const images = Array.from(container.querySelectorAll('img[data-cv-file]'));
  await Promise.all(images.map(async (img) => {
    const fileId = img.dataset.cvFile;
    try {
      if (!cvwImageUrls.has(fileId)) {
        const res = await fetch(`${API_BASE}/api/files/${fileId}/download`, { headers: { Authorization: `Bearer ${state.token}` } });
        if (!res.ok) throw new Error('missing');
        cvwImageUrls.set(fileId, URL.createObjectURL(await res.blob()));
      }
      img.src = cvwImageUrls.get(fileId);
    } catch (err) {
      img.closest('figure')?.classList.add('cv-image-missing');
      img.alt = 'Image unavailable';
    }
  }));
}

// Called by renderer.js when a canvas has just been opened in one of the editors.
// The canvas opens as the editable page (features/canvas-wysiwyg.js); the button switches to the Markdown source.
function canvasViewOpened(which, { canEdit }) {
  const view = canvasViews[which];
  view.canEdit = canEdit;
  const button = view.modeButton();
  if (button) button.hidden = !canEdit;
  cvwShow(which, 'read');
  if (typeof ccRefreshCount === 'function') ccRefreshCount(which);
}

// Called by renderer.js when another person's save arrives while this canvas is open. The page follows the
// text on its own (it watches the value renderer.js sets), so there is nothing to redraw here.
function canvasViewRefresh() {}

// 'read' = the formatted, editable page; 'edit' = the Markdown source (the textarea).
async function cvwShow(which, mode) {
  const view = canvasViews[which];
  const editor = view.editor();
  const container = view.render();
  const button = view.modeButton();
  if (!editor || !container) return;
  if (mode === 'edit') {
    view.mode = 'edit';
    if (typeof canvasWysiwyg !== 'undefined') canvasWysiwyg.hide(which);
    editor.hidden = false;
    if (button) { button.textContent = 'Page'; button.title = 'Back to the formatted page'; }
    if (typeof canvasEditorSync === 'function') canvasEditorSync();
    editor.focus({ preventScroll: true });
    return;
  }
  view.mode = 'read';
  if (button) { button.textContent = 'Markdown'; button.title = 'Edit the Markdown source'; }
  // whatever was typed in the source is saved first, so the page and the server agree
  view.flush();
  await view.save();
  for (let waited = 0; view.saving() && waited < 3000; waited += 50) await cvwSleep(50);
  if (view.mode !== 'read') return;
  canvasWysiwyg.show(which);
}

async function cvwToggleChecklist(which, token, checkbox) {
  const view = canvasViews[which];
  const separator = token.lastIndexOf(':');
  const sectionId = token.slice(0, separator);
  const item = Number(token.slice(separator + 1));
  const canvasId = view.id();
  try {
    const res = await api(`/api/canvas/${canvasId}`, {
      method: 'PATCH',
      body: JSON.stringify({ operation: { op: 'toggle', sectionId, item, checked: checkbox.checked }, baseRevision: view.revision }),
    });
    const data = await res.json();
    if (res.status === 409 || res.status === 404) {
      showToast('Someone changed this canvas. It was refreshed; try again.', 'info');
    } else if (!res.ok) {
      throw new Error(data.error || 'Could not update the checklist');
    } else {
      // keep the editor's idea of the document in step, so switching to Edit shows the same text
      const editor = view.editor();
      const state = view.state();
      editor.value = data.canvas.content;
      state.revision = data.canvas.revision;
      state.savedContent = data.canvas.content;
    }
  } catch (err) {
    console.error('Toggle checklist error:', err);
    showToast(err.message || 'Could not update the checklist.', 'error');
  }
  await cvwShow(which, 'read');
}

// ---- history ------------------------------------------------------------------------------------

const cvwHistory = { which: null, selected: null };

async function cvwOpenHistory(which) {
  const view = canvasViews[which];
  const canvasId = view.id();
  const modal = document.getElementById('canvas-history-modal');
  if (!canvasId || !modal) return;
  cvwHistory.which = which;
  cvwHistory.selected = null;
  document.getElementById('canvas-history-text').textContent = '';
  document.getElementById('canvas-history-meta').textContent = 'Select a version to preview it.';
  document.getElementById('btn-canvas-history-restore').hidden = true;
  const list = document.getElementById('canvas-history-list');
  list.innerHTML = '<li class="canvas-history-empty">Loading…</li>';
  openSettingsModal(modal);
  try {
    // Make sure what was typed is in the history before it is listed.
    view.flush();
    await view.save();
    const res = await api(`/api/canvas/${canvasId}/revisions`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the history');
    list.innerHTML = data.revisions.length === 0
      ? '<li class="canvas-history-empty">No saved versions yet.</li>'
      : data.revisions.map((r) => `<li><button type="button" class="canvas-history-item" data-cv-revision="${r.revision}">
          <strong>${escapeHtml(new Date(r.editedAt).toLocaleString())}</strong>
          <span>${escapeHtml(r.editedBy ? r.editedBy.username : 'Unknown')} · ${escapeHtml(r.title)}</span>
        </button></li>`).join('');
  } catch (err) {
    console.error('Canvas history error:', err);
    list.innerHTML = `<li class="canvas-history-empty">${escapeHtml(err.message || 'Could not load the history.')}</li>`;
  }
}

async function cvwPreviewRevision(revision) {
  const view = canvasViews[cvwHistory.which];
  try {
    const res = await api(`/api/canvas/${view.id()}/revisions/${revision}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load that version');
    const r = data.revision;
    cvwHistory.selected = r.revision;
    document.querySelectorAll('.canvas-history-item').forEach((b) => b.classList.toggle('active', Number(b.dataset.cvRevision) === r.revision));
    document.getElementById('canvas-history-meta').textContent = `${r.title} — ${new Date(r.editedAt).toLocaleString()}${r.editedBy ? ` by ${r.editedBy.username}` : ''}`;
    document.getElementById('canvas-history-text').textContent = r.content || '(empty)';
    document.getElementById('btn-canvas-history-restore').hidden = !view.canEdit;
  } catch (err) {
    showToast(err.message || 'Could not load that version.', 'error');
  }
}

async function cvwRestoreRevision() {
  const which = cvwHistory.which;
  const view = canvasViews[which];
  if (!which || cvwHistory.selected === null) return;
  const ok = await confirmAction({
    title: 'Restore this version?',
    message: 'It becomes the current version. The version you have now stays in the history, so you can undo this.',
    confirmLabel: 'Restore',
    danger: false,
  });
  if (!ok) return;
  try {
    const res = await api(`/api/canvas/${view.id()}/revisions/${cvwHistory.selected}/restore`, { method: 'POST', body: JSON.stringify({}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not restore that version');
    const state = view.state();
    view.editor().value = data.canvas.content;
    view.title().value = data.canvas.title;
    state.revision = data.canvas.revision;
    state.savedContent = data.canvas.content;
    state.savedTitle = data.canvas.title;
    closeSettingsModal();
    showToast('Version restored.', 'success');
    if (view.mode === 'read') await cvwShow(which, 'read');
  } catch (err) {
    console.error('Restore canvas version error:', err);
    showToast(err.message || 'Could not restore that version.', 'error');
  }
}

// ---- events -------------------------------------------------------------------------------------

document.addEventListener('click', (event) => {
  const modeButton = event.target.closest('#btn-canvas2-mode, #btn-canvas-sheet-mode');
  if (modeButton) {
    const which = modeButton.id === 'btn-canvas2-mode' ? 'standalone' : 'sheet';
    cvwShow(which, canvasViews[which].mode === 'read' ? 'edit' : 'read');
    return;
  }
  const historyButton = event.target.closest('#btn-canvas2-history, #btn-canvas-sheet-history');
  if (historyButton) {
    cvwOpenHistory(historyButton.id === 'btn-canvas2-history' ? 'standalone' : 'sheet');
    return;
  }
  const revisionButton = event.target.closest('[data-cv-revision]');
  if (revisionButton) {
    cvwPreviewRevision(Number(revisionButton.dataset.cvRevision));
    return;
  }
  if (event.target.closest('#btn-canvas-history-restore')) {
    cvwRestoreRevision();
    return;
  }
  if (event.target.closest('#btn-close-canvas-history')) {
    closeSettingsModal();
  }
});

document.addEventListener('change', (event) => {
  const box = event.target.closest('[data-cv-toggle]');
  if (!box) return;
  const which = box.closest('#canvas-sheet-render') ? 'sheet' : 'standalone';
  cvwToggleChecklist(which, box.dataset.cvToggle, box);
});
