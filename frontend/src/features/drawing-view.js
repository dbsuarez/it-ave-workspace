// IT Avenue Workspace - drawings: the card shown in a conversation and the list of drawings.
//
// Pure functions: drawing data in, HTML out, every value escaped. Opening a drawing is handled by delegated click handlers in
// drawings.js, which read the data-drawing-open attribute written here. `updatedText` (for example "5 min ago") is worked out
// by the caller so these stay free of clocks and locales.

// A person's label: their full name when the app has loaded display-name.js, else the username (these views are also tested on their own).
const drawingWho = (ref) => (typeof displayName === 'function' ? displayName(ref) : String((ref && ref.username) || ''));

function drawingEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const DRAWING_ICON = '<svg class="drawing-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

function drawingBadgeHtml(drawing) {
  if (drawing.readOnlyReason === 'locked') return '<span class="drawing-badge">Locked</span>';
  if (drawing.readOnlyReason === 'archived') return '<span class="drawing-badge">Archived</span>';
  if (drawing.role === 'viewer') return '<span class="drawing-badge">View only</span>';
  return '';
}

// The card posted into a channel or forum topic.
// A picture of the drawing that opens it, with the title as a small caption. Until someone has saved a preview it is a plain tile.
// The picture has no address: drawings.js fetches it with the person's sign-in and fills it in (data-drawing-preview).
function drawingCardHtml(drawing) {
  const id = Number(drawing.id);
  const title = drawingEscape(drawing.title);
  const version = Number(drawing.previewVersion);
  const hasPreview = Number.isFinite(version) && version > 0;
  const face = hasPreview
    ? `<img class="drawing-preview-img" data-drawing-preview="${id}" data-preview-version="${version}" alt="Preview of ${title}" draggable="false">`
    : `<span class="drawing-preview-empty">${DRAWING_ICON}<span>No preview yet</span></span>`;
  return `<div class="drawing-card${hasPreview ? ' has-preview' : ''}" data-drawing-card="${id}"><button type="button" class="drawing-preview" data-drawing-open="${id}" aria-label="Open drawing: ${title}">${face}</button><span class="drawing-card-title">${title}</span></div>`;
}

function drawingCardRemovedHtml() {
  return '<div class="drawing-card removed">Drawing removed</div>';
}

// A list of drawings (My drawings, Shared with me, a channel's Drawings tab).
function drawingListHtml(drawings, { empty = 'No drawings yet.' } = {}) {
  if (!drawings.length) return `<div class="drawing-empty">${drawingEscape(empty)}</div>`;
  return drawings.map((drawing) => {
    const id = Number(drawing.id);
    const meta = [drawingEscape(drawingWho({ username: drawing.ownerUsername })), drawingEscape(drawing.updatedText || '')].filter(Boolean).join(' · ');
    return `<div class="drawing-row" data-drawing-id="${id}">
      <button type="button" class="drawing-row-main" data-drawing-open="${id}">${DRAWING_ICON}<span class="drawing-row-title">${drawingEscape(drawing.title)}</span>${drawingBadgeHtml(drawing)}<span class="drawing-row-meta">${meta}</span></button>
    </div>`;
  }).join('');
}

const DRAWING_BANNERS = {
  viewer: 'You can view this drawing but not change it.',
  locked: 'This topic is locked, so the drawing is view-only.',
  archived: 'This place is archived, so the drawing is view-only.',
  'cannot-sync': 'You can no longer sync this drawing. Your changes stay on this computer; export it to keep a copy.',
};

function drawingPresenceHtml(person) {
  const color = /^#[0-9a-fA-F]{6}$/.test(person.color || '') ? person.color : '#6b7280';
  const name = String(drawingWho({ id: person.userId, username: person.username }) || '?');
  return `<span class="drawing-presence" title="${drawingEscape(name)}" style="background:${color}">${drawingEscape(name.charAt(0).toUpperCase())}</span>`;
}

// The bar above an open drawing: back, title, who is here, status, export, share; plus a banner when it is view-only or cannot sync.
// drawing: { id, title, kind, role, readOnlyReason }; status/statusText from drawing-sync.js; present: [{ userId, username, color }].
function drawingBarHtml({ drawing, status = 'saved', statusText = '', present = [], canShare = false, canDelete = false }) {
  const id = Number(drawing.id);
  const editor = drawing.role === 'editor';
  const banner = drawing.readOnlyReason ? DRAWING_BANNERS[drawing.readOnlyReason] : (drawing.role === 'viewer' ? DRAWING_BANNERS.viewer : '');
  const notice = status === 'cannot-sync' ? DRAWING_BANNERS['cannot-sync'] : banner;
  return `<div class="drawing-bar" data-drawing-id="${id}">
    <button type="button" class="btn" data-drawing-back>&larr; Drawings</button>
    <span class="drawing-bar-title">${drawingEscape(drawing.title)}</span>${editor ? '<button type="button" class="icon-btn" data-drawing-rename title="Rename" aria-label="Rename">&#9998;</button>' : ''}
    <span class="drawing-bar-present">${present.map(drawingPresenceHtml).join('')}</span>
    <span class="drawing-status" data-status="${drawingEscape(status)}">${drawingEscape(statusText)}</span>
    <button type="button" class="btn" data-drawing-export="png">Export PNG</button>
    <button type="button" class="btn" data-drawing-export="svg">Export SVG</button>
    <button type="button" class="btn" data-drawing-save-file title="Save as a .excalidraw file that opens in any Excalidraw">Save file</button>
    ${editor ? '<button type="button" class="btn" data-drawing-open-file title="Add the drawing in a .excalidraw file to this one">Open file</button>' : ''}
    ${canShare ? '<button type="button" class="btn primary" data-drawing-share>Share</button>' : ''}
    ${canDelete ? '<button type="button" class="btn danger" data-drawing-delete>Delete</button>' : ''}
  </div>${notice ? `<div class="drawing-banner" role="status">${drawingEscape(notice)}</div>` : ''}`;
}

// The Share dialog of a standalone drawing: invite people, change or remove them, or copy the drawing into a channel or topic.
// members: [{ userId, username, role }]; people: ["Name (username)"] for the search box; channels: [{ id, name, kind }].
function drawingShareHtml({ drawing, members = [], people = [], channels = [] }) {
  const roleSelect = (attrs, current) => `<select ${attrs}><option value="editor"${current === 'editor' ? ' selected' : ''}>Can edit</option><option value="viewer"${current === 'viewer' ? ' selected' : ''}>Can view</option></select>`;
  const rows = members.length
    ? members.map((member) => `<div class="drawing-share-row"><span>${drawingEscape(drawingWho({ id: member.userId, username: member.username }))}</span>${roleSelect(`data-drawing-member-role="${Number(member.userId)}" aria-label="Role of ${drawingEscape(drawingWho({ id: member.userId, username: member.username }))}"`, member.role)}<button type="button" class="btn" data-drawing-member-remove="${Number(member.userId)}">Remove</button></div>`).join('')
    : '<p class="drawing-share-empty">Not shared with anyone yet.</p>';
  return `<div class="modal-header"><h3>Share "${drawingEscape(drawing.title)}"</h3><button class="modal-close" type="button" data-drawing-share-close aria-label="Close">&times;</button></div>
  <div class="modal-body" data-drawing-id="${Number(drawing.id)}">
    <h4>People</h4>
    ${rows}
    <div class="drawing-share-add">
      <input type="text" list="drawing-people-options" data-drawing-add-person placeholder="Add a person (type to search)" autocomplete="off" aria-label="Add a person">
      <datalist id="drawing-people-options">${people.map((label) => `<option value="${drawingEscape(label)}"></option>`).join('')}</datalist>
      ${roleSelect('data-drawing-add-role aria-label="Role for the new person"', 'editor')}
      <button type="button" class="btn primary" data-drawing-add>Add</button>
    </div>
    <h4>Copy into a channel or topic</h4>
    <p class="drawing-share-note">This makes a separate copy that everyone in the channel can edit. Your own drawing stays private.</p>
    <div class="drawing-share-add">
      <select data-drawing-copy-channel aria-label="Channel"><option value="">Choose a channel</option>${channels.map((channel) => `<option value="${Number(channel.id)}"${channel.kind === 'forum' ? ' data-forum="1"' : ''}>${drawingEscape(channel.name)}</option>`).join('')}</select>
      <select data-drawing-copy-topic aria-label="Topic" hidden></select>
      <button type="button" class="btn" data-drawing-copy>Copy</button>
    </div>
  </div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { drawingCardHtml, drawingCardRemovedHtml, drawingListHtml, drawingBarHtml, drawingShareHtml, drawingEscape };
}
