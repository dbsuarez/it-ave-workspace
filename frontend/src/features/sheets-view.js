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
function sheetBarHtml({ sheet, status = 'saved', isOwner = false }) {
  const editor = sheet.role === 'editor';
  return `<div class="sheet-bar" data-sheet-id="${Number(sheet.id)}"><button type="button" class="btn" data-sheet-back>&larr; Sheets</button><span class="sheet-bar-title">${sheetEscape(sheet.title)}</span>${editor ? '<button type="button" class="icon-btn" data-sheet-rename title="Rename" aria-label="Rename">&#9998;</button>' : ''}<span class="sheet-status" data-status="${sheetEscape(status)}">${sheetEscape(SHEET_STATUS_TEXT[status] || '')}</span><button type="button" class="btn" data-sheet-export title="Save the open tab as a CSV file that Excel opens">Export CSV</button>${editor ? '<button type="button" class="btn" data-sheet-import title="Add the rows of a CSV file as a new tab">Import CSV</button>' : ''}${isOwner ? '<button type="button" class="btn primary" data-sheet-share>Share</button><button type="button" class="btn danger" data-sheet-delete>Delete</button>' : ''}</div>`;
}

// The Share dialog (the owner's): who the sheet is shared with and how. members: [{ userId, username, role }]; people: ["Name (username)"].
function sheetShareHtml({ sheet, members = [], people = [] }) {
  const roleSelect = (attrs, current) => `<select ${attrs}><option value="editor"${current === 'editor' ? ' selected' : ''}>Can edit</option><option value="viewer"${current === 'viewer' ? ' selected' : ''}>Can view</option></select>`;
  const rows = members.length
    ? members.map((member) => `<div class="drawing-share-row"><span>${sheetEscape(member.username)}</span>${roleSelect(`data-sheet-member-role="${Number(member.userId)}" aria-label="Role of ${sheetEscape(member.username)}"`, member.role)}<button type="button" class="btn" data-sheet-member-remove="${Number(member.userId)}">Remove</button></div>`).join('')
    : '<p class="drawing-share-empty">Not shared with anyone yet.</p>';
  return `<div class="modal-header"><h3>Share "${sheetEscape(sheet.title)}"</h3><button class="modal-close" type="button" data-sheet-share-close aria-label="Close">&times;</button></div><div class="modal-body" data-sheet-id="${Number(sheet.id)}"><h4>People</h4>${rows}<div class="drawing-share-add"><input type="text" list="sheet-people-options" data-sheet-add-person placeholder="Add a person (type to search)" autocomplete="off" aria-label="Add a person"><datalist id="sheet-people-options">${people.map((label) => `<option value="${sheetEscape(label)}"></option>`).join('')}</datalist>${roleSelect('data-sheet-add-role aria-label="Role for the new person"', 'viewer')}<button type="button" class="btn primary" data-sheet-add>Add</button></div><p class="drawing-share-note">People you share with open it from Sheets &gt; Shared with me. Only you can share or delete the sheet.</p></div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sheetListHtml, sheetBarHtml, sheetShareHtml, sheetEscape, SHEET_STATUS_TEXT };
}
