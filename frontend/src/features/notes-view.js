// IT Avenue Workspace - Notes, Keep style: the markup (cards, side menu, floating editor, pickers) and the rules for what each view
// shows. Pure functions: data in, HTML or lists out, every value escaped, no clocks (callers pass `now`). The screen itself,
// which fetches, autosaves and wires the clicks, is notes.js. A note is what GET /api/notes returns (see backend/src/notes.js).

const NOTE_COLORS = [
  { key: 'default', label: 'Default', background: '#ffffff' },
  { key: 'red', label: 'Red', background: '#faafa8' },
  { key: 'orange', label: 'Orange', background: '#f39f76' },
  { key: 'yellow', label: 'Yellow', background: '#fff8b8' },
  { key: 'green', label: 'Green', background: '#e2f6d3' },
  { key: 'teal', label: 'Teal', background: '#b4ddd3' },
  { key: 'blue', label: 'Blue', background: '#d4e4ed' },
  { key: 'darkblue', label: 'Dark blue', background: '#aeccdc' },
  { key: 'purple', label: 'Purple', background: '#d3bfdb' },
  { key: 'pink', label: 'Pink', background: '#f6e2dd' },
  { key: 'brown', label: 'Brown', background: '#e9e3d4' },
  { key: 'gray', label: 'Gray', background: '#efeff1' },
];

const NOTE_CARD_ITEMS_SHOWN = 8;
const NOTE_CARD_LABELS_SHOWN = 3;
const NOTE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function noteEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const noteColorKey = (note) => (NOTE_COLORS.some((c) => c.key === note.color) ? note.color : 'default');
const noteTime = (value) => new Date(value).getTime();

const noteIcon = (path) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const NOTE_ICONS = {
  pin: noteIcon('<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 4H7l3-4z"/>'),
  palette: noteIcon('<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="15.5" cy="10" r="1"/>'),
  archive: noteIcon('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8"/><path d="M10 12h4"/>'),
  unarchive: noteIcon('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8"/><path d="M12 17v-6"/><path d="M9 13l3-3 3 3"/>'),
  trash: noteIcon('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>'),
  restore: noteIcon('<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/>'),
  checklist: noteIcon('<polyline points="4 6 6 8 9 4"/><line x1="12" y1="6" x2="21" y2="6"/><polyline points="4 14 6 16 9 12"/><line x1="12" y1="14" x2="21" y2="14"/>'),
  reminder: noteIcon('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  image: noteIcon('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  label: noteIcon('<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1"/>'),
  undo: noteIcon('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
  redo: noteIcon('<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>'),
  notes: noteIcon('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
  edit: noteIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
};

// ---- times (local noteClock) ----
function noteClock(date) {
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}
const noteSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const noteDateText = (date, now) => `${NOTE_MONTHS[date.getMonth()]} ${date.getDate()}${date.getFullYear() === now.getFullYear() ? '' : `, ${date.getFullYear()}`}`;

// "Edited at 10:01 AM" today, "Edited Nov 10" on another day.
function noteEditedLabel(updatedAt, now = new Date()) {
  const date = new Date(updatedAt);
  return noteSameDay(date, now) ? `Edited at ${noteClock(date)}` : `Edited ${noteDateText(date, now)}`;
}

// "Today, 6:00 PM", "Tomorrow, 9:30 AM", "Nov 25, 12:00 PM".
function reminderLabel(remindAt, now = new Date()) {
  const date = new Date(remindAt);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (noteSameDay(date, now)) return `Today, ${noteClock(date)}`;
  if (noteSameDay(date, tomorrow)) return `Tomorrow, ${noteClock(date)}`;
  return `${noteDateText(date, now)}, ${noteClock(date)}`;
}

// ---- checklist and text ----
const noteNewItemId = () => Math.random().toString(36).slice(2, 10);

function textToItems(text, makeId = noteNewItemId) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => ({ id: makeId(), text: line, done: false }));
}

function itemsToText(items) {
  return (items || []).map((item) => item.text.trim()).filter(Boolean).join('\n');
}

// Whether there is nothing worth saving: no title, no text, no item with words, no picture.
function noteIsEmpty(note) {
  if (String(note.title || '').trim()) return false;
  if (note.images && note.images.length) return false;
  if (note.kind === 'checklist') return !(note.items || []).some((item) => String(item.text || '').trim());
  return !String(note.content || '').trim();
}

// ---- what a view shows ----
function noteSearchText(note, labelsById) {
  const parts = [note.title, note.kind === 'checklist' ? (note.items || []).map((item) => item.text).join(' ') : note.content];
  for (const id of note.labelIds || []) if (labelsById.has(id)) parts.push(labelsById.get(id).name);
  return parts.join(' ').toLowerCase();
}

// view: 'notes' | 'reminders' | 'archive' | 'trash' | 'label'. Returns { pinned, others }, newest first; pins show only on the main wall.
function notesForView(notes, { view = 'notes', labelId = null, query = '', labels = [] } = {}) {
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const needle = String(query || '').trim().toLowerCase();
  const shown = notes.filter((note) => {
    if (view === 'trash') return note.trashed;
    if (note.trashed) return false;
    if (view === 'archive') return note.archived;
    if (view === 'reminders') return Boolean(note.reminder);
    if (view === 'label') return (note.labelIds || []).includes(Number(labelId));
    return !note.archived;
  }).filter((note) => !needle || noteSearchText(note, labelsById).includes(needle))
    .sort((a, b) => noteTime(b.updatedAt) - noteTime(a.updatedAt) || b.id - a.id);
  if (view !== 'notes') return { pinned: [], others: shown };
  return { pinned: shown.filter((note) => note.pinned), others: shown.filter((note) => !note.pinned) };
}

// ---- cards ----
function noteChipsHtml(note, labels, now) {
  const byId = new Map((labels || []).map((label) => [label.id, label]));
  const named = (note.labelIds || []).filter((id) => byId.has(id));
  const chips = named.slice(0, NOTE_CARD_LABELS_SHOWN).map((id) => `<span class="note-chip">${noteEscape(byId.get(id).name)}</span>`).join('');
  const more = named.length > NOTE_CARD_LABELS_SHOWN ? `<span class="note-chip note-chip-more">+${named.length - NOTE_CARD_LABELS_SHOWN}</span>` : '';
  const reminder = note.reminder ? `<span class="note-chip note-reminder-chip">${NOTE_ICONS.reminder}${noteEscape(reminderLabel(note.reminder.remindAt, now))}</span>` : '';
  return reminder || chips || more ? `<div class="note-chips">${reminder}${chips}${more}</div>` : '';
}

const noteCardButton = (hook, title, svg) => `<button type="button" class="note-tool-btn" ${hook} title="${title}" aria-label="${title}">${svg}</button>`;

function noteCardHtml(note, { labels = [], now = new Date() } = {}) {
  const id = Number(note.id);
  const checklist = note.kind === 'checklist';
  const openFirst = [...(note.items || [])].sort((a, b) => Number(a.done) - Number(b.done));
  const items = openFirst.slice(0, NOTE_CARD_ITEMS_SHOWN)
    .map((item) => `<div class="note-item${item.done ? ' done' : ''}"><span class="note-box" aria-hidden="true">${item.done ? '&#9745;' : '&#9744;'}</span><span>${noteEscape(item.text)}</span></div>`).join('');
  const rest = openFirst.length > NOTE_CARD_ITEMS_SHOWN ? `<div class="note-more">+ ${openFirst.length - NOTE_CARD_ITEMS_SHOWN} more</div>` : '';
  const body = checklist ? `${items}${rest}` : (note.content ? `<div class="note-card-body">${noteEscape(String(note.content).slice(0, 600))}</div>` : '');
  const image = note.images && note.images.length
    ? `<img class="note-card-image" data-note-image="${id}:${Number(note.images[0].id)}" alt="" draggable="false">` : '';
  const empty = !image && !note.title && !body ? '<div class="note-card-body note-empty">Empty note</div>' : '';
  let actions;
  if (note.trashed) {
    actions = `${noteCardButton('data-note-restore', 'Restore', NOTE_ICONS.restore)}${noteCardButton('data-note-delete-forever', 'Delete forever', NOTE_ICONS.trash)}`;
  } else {
    actions = `${noteCardButton('data-note-palette', 'Background options', NOTE_ICONS.palette)}${note.archived ? noteCardButton('data-note-unarchive', 'Unarchive', NOTE_ICONS.unarchive) : noteCardButton('data-note-archive', 'Archive', NOTE_ICONS.archive)}${noteCardButton('data-note-trash', 'Delete', NOTE_ICONS.trash)}`;
  }
  const pin = note.trashed ? '' : `<button type="button" class="note-pin" data-note-pin aria-pressed="${note.pinned ? 'true' : 'false'}" title="${note.pinned ? 'Unpin note' : 'Pin note'}" aria-label="${note.pinned ? 'Unpin note' : 'Pin note'}">${NOTE_ICONS.pin}</button>`;
  return `<div class="note-card note-color-${noteColorKey(note)}" data-note-open="${id}" data-note-card="${id}" tabindex="0">${image}${pin}${note.title ? `<div class="note-card-title">${noteEscape(note.title)}</div>` : ''}${body}${empty}${noteChipsHtml(note, labels, now)}<div class="note-card-actions">${actions}</div></div>`;
}

// ---- side menu ----
function notesSidebarHtml({ labels = [], active = { view: 'notes' } } = {}) {
  const current = (view, labelId) => (active.view === view && (view !== 'label' || Number(active.labelId) === Number(labelId)) ? ' aria-current="page"' : '');
  const view = (key, text, svg) => `<button type="button" class="notes-nav-item" data-notes-view="${key}"${current(key)}>${svg}<span>${text}</span></button>`;
  const labelItems = labels.map((label) => `<button type="button" class="notes-nav-item" data-notes-label="${Number(label.id)}"${current('label', label.id)}>${NOTE_ICONS.label}<span>${noteEscape(label.name)}</span></button>`).join('');
  return `<nav class="notes-nav" aria-label="Notes">${view('notes', 'Notes', NOTE_ICONS.notes)}${view('reminders', 'Reminders', NOTE_ICONS.reminder)}${labelItems}<button type="button" class="notes-nav-item" data-notes-edit-labels>${NOTE_ICONS.edit}<span>Edit labels</span></button>${view('archive', 'Archive', NOTE_ICONS.archive)}${view('trash', 'Trash', NOTE_ICONS.trash)}</nav>`;
}

// ---- pickers ----
function noteColorPaletteHtml(current = 'default') {
  return `<div class="note-palette" role="group" aria-label="Background">${NOTE_COLORS.map((c) => `<button type="button" class="note-swatch note-color-${c.key}" data-note-color="${c.key}" aria-pressed="${c.key === current ? 'true' : 'false'}" title="${c.label}" aria-label="${c.label}"></button>`).join('')}</div>`;
}

function noteLabelPickerHtml(labels, selectedIds = []) {
  const chosen = new Set(selectedIds.map(Number));
  const rows = labels.map((label) => `<label class="note-label-option"><input type="checkbox" data-note-label-toggle="${Number(label.id)}"${chosen.has(Number(label.id)) ? ' checked' : ''}> <span>${noteEscape(label.name)}</span></label>`).join('');
  return `<div class="note-label-picker"><div class="note-label-picker-title">Label note</div>${rows}<div class="note-label-new"><input type="text" data-note-label-new maxlength="30" placeholder="Enter label name" aria-label="New label name"><button type="button" class="btn small" data-note-label-create>Create</button></div></div>`;
}

// ---- the floating editor ----
function noteEditorHtml(note, { labels = [], now = new Date() } = {}) {
  const checklist = note.kind === 'checklist';
  const id = note.id ? Number(note.id) : '';
  const images = (note.images || []).map((image) => `<div class="note-editor-image"><img data-note-image="${id}:${Number(image.id)}" alt="" draggable="false"><button type="button" class="note-image-remove" data-note-image-remove="${Number(image.id)}" title="Remove picture" aria-label="Remove picture">&times;</button></div>`).join('');
  const sorted = [...(note.items || [])];
  const rows = sorted.map((item) => `<div class="note-item-row"><input type="checkbox" data-note-item-done="${noteEscape(item.id)}" aria-label="Done"${item.done ? ' checked' : ''}><input type="text" class="note-item-text" data-note-item="${noteEscape(item.id)}" value="${noteEscape(item.text)}" maxlength="500" aria-label="Item"><button type="button" class="note-item-remove" data-note-item-remove="${noteEscape(item.id)}" title="Remove item" aria-label="Remove item">&times;</button></div>`).join('');
  const body = checklist
    ? `<div class="note-editor-items">${rows}<button type="button" class="note-item-add" data-note-item-add>+ List item</button></div>`
    : `<textarea class="note-editor-body" data-note-body rows="4" placeholder="Take a note..." aria-label="Note">${noteEscape(note.content)}</textarea>`;
  const chips = noteChipsHtml(note, labels, now);
  const edited = note.id && note.updatedAt ? `<span class="note-edited">${noteEscape(noteEditedLabel(note.updatedAt, now))}</span>` : '<span class="note-edited"></span>';
  const tool = (name, title, svg) => `<button type="button" class="note-tool-btn" data-note-tool="${name}" title="${title}" aria-label="${title}">${svg}</button>`;
  return `<div class="note-editor-card note-color-${noteColorKey(note)}" data-note-editor data-note-id="${id}">
    ${images}
    <div class="note-editor-head"><input type="text" class="note-editor-title" data-note-title value="${noteEscape(note.title)}" maxlength="200" placeholder="Title" aria-label="Title"><button type="button" class="note-pin" data-note-tool="pin" aria-pressed="${note.pinned ? 'true' : 'false'}" title="${note.pinned ? 'Unpin note' : 'Pin note'}" aria-label="${note.pinned ? 'Unpin note' : 'Pin note'}">${NOTE_ICONS.pin}</button></div>
    ${body}
    ${chips}
    <div class="note-editor-foot">${edited}</div>
    <div class="note-editor-toolbar">
      ${tool('palette', 'Background options', NOTE_ICONS.palette)}${tool('reminder', 'Remind me', NOTE_ICONS.reminder)}${tool('image', 'Add image', NOTE_ICONS.image)}${tool('checklist', checklist ? 'Hide checkboxes' : 'Show checkboxes', NOTE_ICONS.checklist)}${tool('labels', 'Add label', NOTE_ICONS.label)}${tool('archive', note.archived ? 'Unarchive' : 'Archive', note.archived ? NOTE_ICONS.unarchive : NOTE_ICONS.archive)}${tool('trash', 'Delete note', NOTE_ICONS.trash)}${tool('undo', 'Undo', NOTE_ICONS.undo)}${tool('redo', 'Redo', NOTE_ICONS.redo)}
      <span class="note-toolbar-spacer"></span><button type="button" class="btn" data-note-close>Close</button>
    </div>
    <div class="note-popover" data-note-popover hidden></div>
  </div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NOTE_COLORS, NOTE_ICONS, noteEscape, noteEditedLabel, reminderLabel, textToItems, itemsToText, noteIsEmpty, notesForView,
    noteCardHtml, notesSidebarHtml, noteColorPaletteHtml, noteLabelPickerHtml, noteEditorHtml,
  };
}
