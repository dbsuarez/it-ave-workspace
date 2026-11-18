// IT Avenue Workspace - Sheets: markup for the list and the top bar. Pure: data in, HTML out, every value escaped.
// The screen itself (opening, saving, merging) is sheets.js.

function sheetEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SHEET_ICON = '<svg class="sheet-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>';

// sheets: [{ id, title, ownerUsername, role, tabCount, updatedText }]
function sheetListHtml(sheets, { empty = 'No sheets yet.' } = {}) {
  if (!sheets.length) return `<p class="sheet-empty">${sheetEscape(empty)}</p>`;
  return sheets.map((sheet) => {
    const id = Number(sheet.id);
    const tabs = Number(sheet.tabCount) || 1;
    return `<div class="sheet-row"><button type="button" class="sheet-row-main" data-sheet-open="${id}">${SHEET_ICON}<span class="sheet-row-title">${sheetEscape(sheet.title)}</span>${sheet.role === 'viewer' ? '<span class="sheet-badge">View only</span>' : ''}<span class="sheet-row-meta">${sheetEscape(sheet.ownerUsername || '')} · ${tabs} ${tabs === 1 ? 'tab' : 'tabs'} · ${sheetEscape(sheet.updatedText || '')}</span></button></div>`;
  }).join('');
}

const SHEET_STATUS_TEXT = { saved: 'Saved', saving: 'Saving...', unsaved: 'Unsaved changes', error: 'Could not save: retrying', viewing: 'View only' };

// The top bar of an open sheet. status: 'saved' | 'saving' | 'unsaved' | 'error' | 'viewing'.
function sheetBarHtml({ sheet, status = 'saved' }) {
  const editor = sheet.role === 'editor';
  return `<div class="sheet-bar" data-sheet-id="${Number(sheet.id)}"><button type="button" class="btn" data-sheet-back>&larr; Sheets</button><span class="sheet-bar-title">${sheetEscape(sheet.title)}</span>${editor ? '<button type="button" class="icon-btn" data-sheet-rename title="Rename" aria-label="Rename">&#9998;</button>' : ''}<span class="sheet-status" data-status="${sheetEscape(status)}">${sheetEscape(SHEET_STATUS_TEXT[status] || '')}</span></div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sheetListHtml, sheetBarHtml, sheetEscape, SHEET_STATUS_TEXT };
}
