// IT Avenue Workspace - drawings: the card shown in a conversation and the list of drawings.
//
// Pure functions: drawing data in, HTML out, every value escaped. Opening a drawing is handled by delegated click handlers in
// drawings.js, which read the data-drawing-open attribute written here. `updatedText` (for example "5 min ago") is worked out
// by the caller so these stay free of clocks and locales.

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
function drawingCardHtml(drawing) {
  const id = Number(drawing.id);
  return `<div class="drawing-card" data-drawing-card="${id}">${DRAWING_ICON}<span class="drawing-card-title">${drawingEscape(drawing.title)}</span><button type="button" class="btn" data-drawing-open="${id}">Open</button></div>`;
}

function drawingCardRemovedHtml() {
  return '<div class="drawing-card removed">Drawing removed</div>';
}

// A list of drawings (My drawings, Shared with me, a channel's Drawings tab).
function drawingListHtml(drawings, { empty = 'No drawings yet.' } = {}) {
  if (!drawings.length) return `<div class="drawing-empty">${drawingEscape(empty)}</div>`;
  return drawings.map((drawing) => {
    const id = Number(drawing.id);
    const meta = [drawingEscape(drawing.ownerUsername || ''), drawingEscape(drawing.updatedText || '')].filter(Boolean).join(' · ');
    return `<div class="drawing-row" data-drawing-id="${id}">
      <button type="button" class="drawing-row-main" data-drawing-open="${id}">${DRAWING_ICON}<span class="drawing-row-title">${drawingEscape(drawing.title)}</span>${drawingBadgeHtml(drawing)}<span class="drawing-row-meta">${meta}</span></button>
    </div>`;
  }).join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { drawingCardHtml, drawingCardRemovedHtml, drawingListHtml, drawingEscape };
}
