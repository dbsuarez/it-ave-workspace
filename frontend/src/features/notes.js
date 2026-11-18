// IT Avenue Workspace - the Notes screen, Keep style: a wall of cards, a side menu, search, and a floating editor that saves by
// itself. Markup and view rules come from notes-view.js; this file fetches, autosaves and wires the clicks. Loaded before
// renderer.js, which calls setupNotes() once and loadNotes() whenever the Notes section opens.

const notesState = {
  notes: [], labels: [], view: 'notes', labelId: null, query: '',
  editing: null, saveTimer: null, saving: Promise.resolve(), imageUrls: new Map(), popoverFor: null,
};

const NOTE_SAVE_DELAY_MS = 800;
const NOTE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const noteHost = (id) => document.getElementById(id);
const noteById = (id) => notesState.notes.find((note) => note.id === Number(id)) || null;
const noteJson = async (path, options) => {
  const response = await api(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};

function upsertNote(note) {
  const index = notesState.notes.findIndex((candidate) => candidate.id === note.id);
  if (index >= 0) notesState.notes[index] = note; else notesState.notes.unshift(note);
}

// ------------------------------------------------------------------------------------------------------- loading and drawing
async function loadNotes() {
  const wall = noteHost('notes-wall');
  if (!wall) return;
  if (!notesState.notes.length) wall.innerHTML = '<div class="empty-state" style="padding:24px;">Loading notes…</div>';
  try {
    const data = await noteJson('/api/notes');
    notesState.notes = data.notes || [];
    notesState.labels = data.labels || [];
    renderNotesScreen();
  } catch (err) {
    console.error('Load notes error:', err);
    wall.innerHTML = '<div class="empty-state" style="padding:24px;"><h2>Could not load notes</h2><p style="color:var(--text-muted);">Check that the server is running.</p></div>';
  }
}

function renderNotesScreen() {
  renderNotesSide();
  renderNotesWall();
}

function renderNotesSide() {
  const side = noteHost('notes-side');
  if (side) side.innerHTML = notesSidebarHtml({ labels: notesState.labels, active: { view: notesState.view, labelId: notesState.labelId } });
}

const NOTES_EMPTY = {
  notes: ['Notes you add appear here', 'Use "Take a note..." above to start.'],
  reminders: ['Notes with upcoming reminders appear here', 'Open a note and press the bell to be reminded.'],
  archive: ['Your archived notes appear here', 'Archive a note to keep it without cluttering the wall.'],
  trash: ['No notes in Trash', 'Deleted notes stay here for 30 days.'],
  label: ['No notes with this label yet', 'Add the label to a note from its editor.'],
};

function renderNotesWall() {
  const wall = noteHost('notes-wall');
  const take = noteHost('notes-take');
  if (!wall) return;
  const { view, labelId, query } = notesState;
  if (take) {
    take.hidden = !(view === 'notes' || view === 'label');
    if (!take.hidden && !take.innerHTML) {
      take.innerHTML = `<button type="button" class="notes-take-bar" data-notes-take>Take a note...</button><button type="button" class="note-tool-btn" data-notes-take-list title="New list" aria-label="New list">${NOTE_ICONS.checklist}</button>`;
    }
  }
  const shown = notesForView(notesState.notes, { view, labelId, query, labels: notesState.labels });
  const cards = (list) => `<div class="notes-masonry">${list.map((note) => noteCardHtml(note, { labels: notesState.labels })).join('')}</div>`;
  let html = '';
  if (view === 'trash' && shown.others.length) {
    html += '<div class="notes-trash-bar"><span>Notes in Trash are deleted after 30 days.</span><button type="button" class="btn" data-notes-empty-trash>Empty Trash</button></div>';
  }
  if (!shown.pinned.length && !shown.others.length) {
    const [title, text] = query.trim() ? ['No matching notes', 'Try different words.'] : (NOTES_EMPTY[view] || NOTES_EMPTY.notes);
    html += `<div class="notes-empty"><h2>${noteEscape(title)}</h2><p>${noteEscape(text)}</p></div>`;
  } else {
    if (shown.pinned.length) html += `<div class="notes-section-title">Pinned</div>${cards(shown.pinned)}${shown.others.length ? '<div class="notes-section-title">Others</div>' : ''}`;
    if (shown.others.length) html += cards(shown.others);
  }
  wall.innerHTML = html;
  fillNoteImages(wall);
}

// ------------------------------------------------------------------------------------------------------------- pictures
async function fillNoteImage(image) {
  const key = image.dataset.noteImage;
  if (image.dataset.loaded === key) return;
  let url = notesState.imageUrls.get(key);
  if (!url) {
    const [noteId, imageId] = key.split(':');
    try {
      const response = await api(`/api/notes/${noteId}/images/${imageId}`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      url = URL.createObjectURL(await response.blob());
      notesState.imageUrls.set(key, url);
    } catch (err) { image.hidden = true; return; }
  }
  image.dataset.loaded = key;
  image.src = url;
}
const fillNoteImages = (root) => root.querySelectorAll('img[data-note-image]').forEach(fillNoteImage);

// -------------------------------------------------------------------------------------------------------------- saving
const noteFields = (note) => ({
  title: note.title, kind: note.kind, color: note.color, pinned: note.pinned, labelIds: note.labelIds,
  content: note.kind === 'checklist' ? '' : note.content, items: note.kind === 'checklist' ? note.items : [],
});

// Saves the open note (creating it the first time there is something in it). Saves run one after another.
function saveEditing({ force = false } = {}) {
  clearTimeout(notesState.saveTimer);
  notesState.saving = notesState.saving.then(async () => {
    const note = notesState.editing;
    if (!note) return;
    try {
      if (!note.id) {
        if (!force && noteIsEmpty(note)) return;
        const created = (await noteJson('/api/notes', { method: 'POST', body: JSON.stringify(noteFields(note)) })).note;
        note.id = created.id; note.updatedAt = created.updatedAt; note.images = created.images; note.reminder = created.reminder;
        upsertNote({ ...note });
      } else {
        const saved = (await noteJson(`/api/notes/${note.id}`, { method: 'PUT', body: JSON.stringify(noteFields(note)) })).note;
        note.updatedAt = saved.updatedAt;
        upsertNote({ ...saved, ...noteFields(note), images: saved.images, reminder: saved.reminder, archived: saved.archived, trashed: saved.trashed });
      }
      const edited = document.querySelector('[data-note-editor] .note-edited');
      if (edited && note.updatedAt) edited.textContent = noteEditedLabel(note.updatedAt);
      renderNotesWall();
    } catch (err) { showToast(err.message || 'Could not save the note.', 'error'); }
  });
  return notesState.saving;
}

const scheduleNoteSave = () => { clearTimeout(notesState.saveTimer); notesState.saveTimer = setTimeout(() => saveEditing(), NOTE_SAVE_DELAY_MS); };

// A change to a note that is not open (from a card): saved at once.
async function patchNote(id, change, message) {
  try {
    const saved = (await noteJson(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(change) })).note;
    upsertNote(saved);
    renderNotesScreen();
    if (message) showToast(message, 'success');
    return saved;
  } catch (err) { showToast(err.message || 'Could not change the note.', 'error'); return null; }
}

// -------------------------------------------------------------------------------------------------------------- editor
const noteEditorOpen = () => Boolean(notesState.editing);

// The text box grows with what is written, up to 60% of the window height, and scrolls after that.
function autosizeNoteBody() {
  const box = document.querySelector('[data-note-editor] [data-note-body]');
  if (!box) return;
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, Math.floor(window.innerHeight * 0.6))}px`;
}

function renderNoteEditor(focus) {
  const overlay = noteHost('note-editor-overlay');
  if (!overlay || !notesState.editing) return;
  overlay.hidden = false;
  overlay.innerHTML = noteEditorHtml(notesState.editing, { labels: notesState.labels });
  fillNoteImages(overlay);
  autosizeNoteBody();
  if (focus) overlay.querySelector(focus)?.focus();
}

function openNoteEditor(note, { checklist = false } = {}) {
  if (notesState.editing) return;
  notesState.editing = note ? JSON.parse(JSON.stringify(note)) : {
    id: null, title: '', content: '', kind: checklist ? 'checklist' : 'text', items: checklist ? [{ id: newNoteItemId(), text: '', done: false }] : [],
    color: 'default', pinned: false, archived: false, trashed: false, images: [], reminder: null, updatedAt: null,
    labelIds: notesState.view === 'label' && notesState.labelId ? [notesState.labelId] : [],
  };
  renderNoteEditor(note ? null : (checklist ? '[data-note-item]' : '[data-note-body]'));
}

const newNoteItemId = () => Math.random().toString(36).slice(2, 10);

async function closeNoteEditor() {
  const note = notesState.editing;
  if (!note) return;
  clearTimeout(notesState.saveTimer);
  await saveEditing();
  notesState.editing = null;
  const overlay = noteHost('note-editor-overlay');
  if (overlay) { overlay.hidden = true; overlay.innerHTML = ''; }
  if (note.id && noteIsEmpty(note) && !note.reminder) { // an emptied note is thrown away, as in Keep
    try { await noteJson(`/api/notes/${note.id}`, { method: 'DELETE' }); notesState.notes = notesState.notes.filter((n) => n.id !== note.id); } catch (err) { /* it stays */ }
  }
  renderNotesScreen();
}

async function ensureNoteSaved() {
  await saveEditing({ force: true });
  return notesState.editing && notesState.editing.id;
}

function showNotePopover(html) {
  const popover = document.querySelector('[data-note-editor] [data-note-popover]');
  if (!popover) return;
  popover.innerHTML = html;
  popover.hidden = false;
}
const hideNotePopover = () => { const popover = document.querySelector('[data-note-editor] [data-note-popover]'); if (popover) { popover.hidden = true; popover.innerHTML = ''; } };

function reminderChoices(now = new Date()) {
  const at = (days, hour) => { const date = new Date(now); date.setDate(date.getDate() + days); date.setHours(hour, 0, 0, 0); return date; };
  const nextMonday = at(((8 - now.getDay()) % 7) || 7, 8);
  const choices = [];
  if (now.getHours() < 17) choices.push(['later', 'Later today', at(0, 18)]);
  choices.push(['tomorrow', 'Tomorrow morning', at(1, 8)], ['week', 'Next week', nextMonday]);
  return choices;
}

function noteReminderPopoverHtml(note) {
  const choices = reminderChoices().map(([key, label, date]) => `<button type="button" class="note-popover-item" data-note-remind="${date.toISOString()}"><span>${label}</span><small>${noteEscape(reminderLabel(date.toISOString()))}</small></button>`).join('');
  const clear = note.reminder ? '<button type="button" class="note-popover-item" data-note-remind-clear>Remove reminder</button>' : '';
  return `<div class="note-reminder-picker"><div class="note-label-picker-title">Remind me</div>${choices}<div class="note-label-new"><input type="datetime-local" data-note-remind-custom aria-label="Date and time"><button type="button" class="btn small" data-note-remind-custom-save>Save</button></div>${clear}</div>`;
}

async function setNoteReminder(iso) {
  const id = await ensureNoteSaved();
  if (!id) return;
  try {
    const saved = (await noteJson(`/api/notes/${id}/reminder`, { method: iso ? 'PUT' : 'DELETE', ...(iso ? { body: JSON.stringify({ remindAt: iso }) } : {}) })).note;
    notesState.editing.reminder = saved.reminder;
    upsertNote({ ...saved, ...noteFields(notesState.editing) });
    hideNotePopover();
    renderNoteEditor();
    renderNotesWall();
  } catch (err) { showToast(err.message || 'Could not set the reminder.', 'error'); }
}

async function addNoteImage(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { showToast('Pictures can be PNG, JPEG, GIF or WebP.', 'error'); return; }
  if (file.size > NOTE_IMAGE_MAX_BYTES) { showToast('A picture can be at most 2 MB.', 'error'); return; }
  const id = await ensureNoteSaved();
  if (!id) return;
  try {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const added = (await noteJson(`/api/notes/${id}/images`, { method: 'POST', body: JSON.stringify({ mime: file.type, dataBase64 }) })).image;
    notesState.editing.images.push(added);
    upsertNote({ ...noteById(id), images: [...notesState.editing.images] });
    renderNoteEditor();
    renderNotesWall();
  } catch (err) { showToast(err.message || 'Could not add the picture.', 'error'); }
}

async function toggleChecklist() {
  const note = notesState.editing;
  if (note.kind === 'checklist') { note.content = itemsToText(note.items); note.items = []; note.kind = 'text'; }
  else { note.items = textToItems(note.content, newNoteItemId); if (!note.items.length) note.items = [{ id: newNoteItemId(), text: '', done: false }]; note.content = ''; note.kind = 'checklist'; }
  renderNoteEditor(note.kind === 'checklist' ? '[data-note-item]' : '[data-note-body]');
  scheduleNoteSave();
}

function handleNoteTool(tool, event) {
  const note = notesState.editing;
  if (tool === 'pin') { note.pinned = !note.pinned; if (note.pinned) note.archived = false; renderNoteEditor(); scheduleNoteSave(); return; }
  if (tool === 'palette') { showNotePopover(noteColorPaletteHtml(note.color)); return; }
  if (tool === 'reminder') { showNotePopover(noteReminderPopoverHtml(note)); return; }
  if (tool === 'labels') { showNotePopover(noteLabelPickerHtml(notesState.labels, note.labelIds)); return; }
  if (tool === 'checklist') { toggleChecklist(); return; }
  if (tool === 'image') { noteHost('note-image-input').click(); return; }
  if (tool === 'undo' || tool === 'redo') { document.execCommand(tool); return; }
  if (tool === 'archive') { archiveEditing(); return; }
  if (tool === 'trash') { trashEditing(); return; }
}

async function archiveEditing() {
  const id = await ensureNoteSaved();
  if (!id) return;
  const archive = !notesState.editing.archived;
  notesState.editing.archived = archive;
  if (archive) notesState.editing.pinned = false;
  await saveEditing();
  const saved = await patchNote(id, { archived: archive }, archive ? 'Note archived.' : 'Note unarchived.');
  if (saved) { notesState.editing.archived = saved.archived; }
  await closeNoteEditor();
}

async function trashEditing() {
  const note = notesState.editing;
  if (!note.id) { notesState.editing = null; noteHost('note-editor-overlay').hidden = true; noteHost('note-editor-overlay').innerHTML = ''; return; }
  clearTimeout(notesState.saveTimer);
  await saveEditing();
  await patchNote(note.id, { trashed: true }, 'Note moved to Trash.');
  notesState.editing = null;
  noteHost('note-editor-overlay').hidden = true; noteHost('note-editor-overlay').innerHTML = '';
}

function handleEditorClick(event) {
  const target = event.target;
  if (target === noteHost('note-editor-overlay')) { closeNoteEditor(); return; }
  if (!notesState.editing) return;
  if (target.closest('[data-note-close]')) { closeNoteEditor(); return; }
  const tool = target.closest('[data-note-tool]');
  if (tool) { hideNotePopover(); handleNoteTool(tool.dataset.noteTool, event); return; }
  const swatch = target.closest('[data-note-color]');
  if (swatch) {
    notesState.editing.color = swatch.dataset.noteColor;
    document.querySelector('[data-note-editor]').className = `note-editor-card note-color-${notesState.editing.color}`;
    showNotePopover(noteColorPaletteHtml(notesState.editing.color));
    scheduleNoteSave();
    return;
  }
  const remind = target.closest('[data-note-remind]');
  if (remind) { setNoteReminder(remind.dataset.noteRemind); return; }
  if (target.closest('[data-note-remind-clear]')) { setNoteReminder(null); return; }
  if (target.closest('[data-note-remind-custom-save]')) {
    const value = document.querySelector('[data-note-remind-custom]').value;
    if (!value) { showToast('Pick a date and time first.', 'info'); return; }
    setNoteReminder(new Date(value).toISOString());
    return;
  }
  if (target.closest('[data-note-label-create]')) { createLabelFromPicker(); return; }
  const add = target.closest('[data-note-item-add]');
  if (add) { addItemAfter(null); return; }
  const removeItem = target.closest('[data-note-item-remove]');
  if (removeItem) {
    notesState.editing.items = notesState.editing.items.filter((item) => item.id !== removeItem.dataset.noteItemRemove);
    renderNoteEditor(); scheduleNoteSave();
    return;
  }
  const removeImage = target.closest('[data-note-image-remove]');
  if (removeImage) { removeNoteImage(Number(removeImage.dataset.noteImageRemove)); return; }
}

async function removeNoteImage(imageId) {
  const note = notesState.editing;
  try {
    await noteJson(`/api/notes/${note.id}/images/${imageId}`, { method: 'DELETE' });
    note.images = note.images.filter((image) => image.id !== imageId);
    const stored = noteById(note.id);
    if (stored) upsertNote({ ...stored, images: [...note.images] });
    renderNoteEditor(); renderNotesWall();
  } catch (err) { showToast(err.message || 'Could not remove the picture.', 'error'); }
}

async function createLabelFromPicker() {
  const input = document.querySelector('[data-note-label-new]');
  const name = input.value.trim();
  if (!name) return;
  try {
    const label = (await noteJson('/api/notes/labels', { method: 'POST', body: JSON.stringify({ name }) })).label;
    notesState.labels.push(label);
    notesState.labels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    notesState.editing.labelIds = [...new Set([...notesState.editing.labelIds, label.id])];
    renderNotesSide();
    renderNoteEditor();
    showNotePopover(noteLabelPickerHtml(notesState.labels, notesState.editing.labelIds));
    scheduleNoteSave();
  } catch (err) { showToast(err.message || 'Could not create the label.', 'error'); }
}

function addItemAfter(itemId) {
  const note = notesState.editing;
  const item = { id: newNoteItemId(), text: '', done: false };
  const index = itemId ? note.items.findIndex((candidate) => candidate.id === itemId) : note.items.length - 1;
  note.items.splice(index + 1, 0, item);
  renderNoteEditor(`[data-note-item="${item.id}"]`);
  scheduleNoteSave();
}

function handleEditorInput(event) {
  const note = notesState.editing;
  if (!note) return;
  const target = event.target;
  if (target.matches('[data-note-title]')) note.title = target.value;
  else if (target.matches('[data-note-body]')) { note.content = target.value; autosizeNoteBody(); }
  else if (target.matches('[data-note-item]')) { const item = note.items.find((i) => i.id === target.dataset.noteItem); if (item) item.text = target.value; }
  else if (target.matches('[data-note-item-done]')) { const item = note.items.find((i) => i.id === target.dataset.noteItemDone); if (item) { item.done = target.checked; } }
  else if (target.matches('[data-note-label-toggle]')) {
    const id = Number(target.dataset.noteLabelToggle);
    note.labelIds = target.checked ? [...new Set([...note.labelIds, id])] : note.labelIds.filter((l) => l !== id);
    const chips = document.querySelector('[data-note-editor]');
    scheduleNoteSave();
    return;
  } else return;
  scheduleNoteSave();
}

function handleEditorKeydown(event) {
  const note = notesState.editing;
  if (!note) return;
  if (event.key === 'Escape') { event.stopPropagation(); closeNoteEditor(); return; }
  const input = event.target.closest && event.target.closest('[data-note-item]');
  if (!input) return;
  if (event.key === 'Enter') { event.preventDefault(); addItemAfter(input.dataset.noteItem); }
  else if (event.key === 'Backspace' && input.value === '' && note.items.length > 1) {
    event.preventDefault();
    const index = note.items.findIndex((i) => i.id === input.dataset.noteItem);
    note.items.splice(index, 1);
    renderNoteEditor(`[data-note-item="${note.items[Math.max(0, index - 1)].id}"]`);
    scheduleNoteSave();
  }
}

// ------------------------------------------------------------------------------------------------------------ the wall
async function handleWallClick(event) {
  const target = event.target;
  if (target.closest('[data-notes-empty-trash]')) {
    if (!(await confirmAction({ title: 'Empty Trash?', message: 'Every note in Trash is deleted for good.', confirmLabel: 'Empty Trash' }))) return;
    try { await noteJson('/api/notes/trash/empty', { method: 'POST' }); notesState.notes = notesState.notes.filter((n) => !n.trashed); renderNotesScreen(); showToast('Trash emptied.', 'success'); } catch (err) { showToast(err.message, 'error'); }
    return;
  }
  if (target.closest('[data-notes-take]')) { openNoteEditor(null); return; }
  if (target.closest('[data-notes-take-list]')) { openNoteEditor(null, { checklist: true }); return; }
  const card = target.closest('[data-note-card]');
  if (!card) return;
  const note = noteById(card.dataset.noteCard);
  if (!note) return;
  const swatch = target.closest('[data-note-color]');
  if (swatch) { patchNote(note.id, { color: swatch.dataset.noteColor }); return; }
  if (target.closest('[data-note-pin]')) { patchNote(note.id, { pinned: !note.pinned }); return; }
  if (target.closest('[data-note-palette]')) {
    const existing = card.querySelector('.note-popover');
    if (existing) { existing.remove(); return; }
    document.querySelectorAll('.note-card .note-popover').forEach((p) => p.remove());
    const popover = document.createElement('div');
    popover.className = 'note-popover note-card-popover';
    popover.innerHTML = noteColorPaletteHtml(note.color);
    card.appendChild(popover);
    return;
  }
  if (target.closest('[data-note-archive]')) { patchNote(note.id, { archived: true }, 'Note archived.'); return; }
  if (target.closest('[data-note-unarchive]')) { patchNote(note.id, { archived: false }, 'Note unarchived.'); return; }
  if (target.closest('[data-note-trash]')) { patchNote(note.id, { trashed: true }, 'Note moved to Trash.'); return; }
  if (target.closest('[data-note-restore]')) { patchNote(note.id, { trashed: false }, 'Note restored.'); return; }
  if (target.closest('[data-note-delete-forever]')) {
    if (!(await confirmAction({ title: 'Delete forever?', message: 'This note will be deleted for good.', confirmLabel: 'Delete forever' }))) return;
    try { await noteJson(`/api/notes/${note.id}`, { method: 'DELETE' }); notesState.notes = notesState.notes.filter((n) => n.id !== note.id); renderNotesScreen(); } catch (err) { showToast(err.message, 'error'); }
    return;
  }
  if (note.trashed) { showToast('Restore the note to edit it.', 'info'); return; }
  openNoteEditor(note);
}

function handleSideClick(event) {
  const view = event.target.closest('[data-notes-view]');
  const label = event.target.closest('[data-notes-label]');
  if (view) { notesState.view = view.dataset.notesView; notesState.labelId = null; renderNotesScreen(); return; }
  if (label) { notesState.view = 'label'; notesState.labelId = Number(label.dataset.notesLabel); renderNotesScreen(); return; }
  if (event.target.closest('[data-notes-edit-labels]')) openLabelsDialog();
}

// ------------------------------------------------------------------------------------------------------- labels dialog
function labelsDialogHtml() {
  const rows = notesState.labels.map((label) => `<div class="note-label-row" data-label-row="${label.id}"><input type="text" value="${noteEscape(label.name)}" maxlength="30" data-label-rename="${label.id}" aria-label="Label name"><button type="button" class="btn small danger" data-label-delete="${label.id}">Delete</button></div>`).join('');
  return `<div class="modal open role-modal note-labels-modal" role="dialog" aria-modal="true" aria-label="Edit labels"><div class="modal-header"><h3>Edit labels</h3><button class="modal-close" type="button" data-labels-close aria-label="Close">&times;</button></div>
    <div class="modal-body"><div class="note-label-new"><input type="text" maxlength="30" data-label-create-name placeholder="Create new label" aria-label="New label"><button type="button" class="btn primary small" data-label-create>Create</button></div>${rows || '<p class="moderation-help">No labels yet.</p>'}</div></div>`;
}

function openLabelsDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'notes-labels-overlay';
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = labelsDialogHtml();
  document.body.appendChild(overlay);
  const redraw = () => { overlay.innerHTML = labelsDialogHtml(); renderNotesSide(); };
  overlay.addEventListener('click', async (event) => {
    if (event.target === overlay || event.target.closest('[data-labels-close]')) { overlay.remove(); renderNotesScreen(); return; }
    const create = event.target.closest('[data-label-create]');
    const del = event.target.closest('[data-label-delete]');
    try {
      if (create) {
        const input = overlay.querySelector('[data-label-create-name]');
        if (!input.value.trim()) return;
        const label = (await noteJson('/api/notes/labels', { method: 'POST', body: JSON.stringify({ name: input.value.trim() }) })).label;
        notesState.labels.push(label);
        notesState.labels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        redraw();
      } else if (del) {
        const id = Number(del.dataset.labelDelete);
        if (!(await confirmAction({ title: 'Delete label?', message: 'The label is removed from your notes. The notes stay.', confirmLabel: 'Delete label' }))) return;
        await noteJson(`/api/notes/labels/${id}`, { method: 'DELETE' });
        notesState.labels = notesState.labels.filter((label) => label.id !== id);
        notesState.notes.forEach((note) => { note.labelIds = note.labelIds.filter((l) => l !== id); });
        if (notesState.view === 'label' && notesState.labelId === id) { notesState.view = 'notes'; notesState.labelId = null; }
        redraw();
      }
    } catch (err) { showToast(err.message || 'Could not change labels.', 'error'); }
  });
  overlay.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-label-rename]');
    if (!input) return;
    const id = Number(input.dataset.labelRename);
    try {
      const label = (await noteJson(`/api/notes/labels/${id}`, { method: 'PUT', body: JSON.stringify({ name: input.value }) })).label;
      const stored = notesState.labels.find((l) => l.id === id);
      if (stored) stored.name = label.name;
      notesState.labels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      renderNotesSide();
    } catch (err) { showToast(err.message || 'Could not rename the label.', 'error'); input.value = (notesState.labels.find((l) => l.id === id) || {}).name || ''; }
  });
}

// ------------------------------------------------------------------------------------------------------------- set-up
function setupNotes() {
  const overlay = noteHost('note-editor-overlay');
  if (overlay) {
    overlay.addEventListener('click', handleEditorClick);
    overlay.addEventListener('input', handleEditorInput);
    overlay.addEventListener('keydown', handleEditorKeydown);
  }
  noteHost('notes-wall')?.addEventListener('click', handleWallClick);
  noteHost('notes-take')?.addEventListener('click', handleWallClick);
  noteHost('notes-side')?.addEventListener('click', handleSideClick);
  noteHost('notes-search')?.addEventListener('input', (event) => { notesState.query = event.target.value; renderNotesWall(); });
  noteHost('note-image-input')?.addEventListener('change', (event) => { const file = event.target.files && event.target.files[0]; event.target.value = ''; addNoteImage(file); });
  document.addEventListener('click', (event) => { if (!event.target.closest('.note-card')) document.querySelectorAll('.note-card .note-popover').forEach((p) => p.remove()); });
}
