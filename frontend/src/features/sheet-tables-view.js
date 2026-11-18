// IT Avenue Workspace - Sheets: markup for the Tables dialog (declare a tab as a table, check it, publish it). Pure and tested.
// A table is a tab whose first row is the header and whose columns have types; Publish checks every row and saves the typed rows,
// which are what the rest of the app reads (docs/superpowers/specs/2026-11-19-sheets-design.md).

const SHEET_COLUMN_TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date (YYYY-MM-DD)'], ['yesno', 'Yes / No'], ['person', 'Person (username)']];
const SHEET_TABLE_MAX_COLUMNS = 50;

// What a table can feed in Leave, and the columns that needs (the same as backend/src/leaveFeeds.js).
const SHEET_FEED_KINDS = [['', 'Nothing (just data)'], ['holidays', 'Company holidays in Leave'], ['credits', 'Leave credits in Leave']];
const SHEET_FEED_LABELS = { holidays: 'company holidays', credits: 'leave credits' };
const SHEET_FEED_COLUMNS = {
  holidays: [{ name: 'date', type: 'date', required: true }, { name: 'name', type: 'text', required: true }],
  credits: [{ name: 'person', type: 'person', required: true }, { name: 'leave_type', type: 'text', required: true }, { name: 'year', type: 'number', required: true }, { name: 'days', type: 'number', required: true }],
};

// True when the columns include every one the feed needs, with the right type (any case, extra columns allowed).
function feedColumnsFit(feeds, columns) {
  if (!feeds) return true;
  return (SHEET_FEED_COLUMNS[feeds] || []).every((need) => columns.some((column) => String(column.name).trim().toLowerCase() === need.name && column.type === need.type));
}

// Exactly the columns a feed needs, as fresh copies.
function feedColumnsFor(feeds) {
  return (SHEET_FEED_COLUMNS[feeds] || []).map((column) => ({ ...column }));
}

const tableEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function tableAgo(iso, now) {
  const seconds = Math.max(0, Math.round(((now instanceof Date ? now.getTime() : Date.now()) - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// tables: [{ name, tabId, tabName, columns, published: { at, by, rowCount, stale } | null }]
function sheetTablesHtml({ tables, canEdit, now = new Date() }) {
  const rows = tables.map((table) => {
    const columns = table.columns.map((column) => `${tableEscape(column.name)} (${tableEscape(column.type)})`).join(', ');
    const published = table.published
      ? `Published ${tableEscape(tableAgo(table.published.at, now))}${table.published.by ? ` by ${tableEscape(table.published.by)}` : ''} · ${Number(table.published.rowCount)} row${Number(table.published.rowCount) === 1 ? '' : 's'}${table.published.stale ? ' <strong class="sheet-table-stale">The sheet has changed since: publish again to update it</strong>' : ''}`
      : 'Not published';
    const actions = canEdit
      ? `<button type="button" class="btn small" data-sheet-table-edit="${tableEscape(table.name)}">Edit</button><button type="button" class="btn small" data-sheet-table-check="${tableEscape(table.name)}">Check</button><button type="button" class="btn small primary" data-sheet-table-publish="${tableEscape(table.name)}">Publish</button><button type="button" class="btn small danger" data-sheet-table-remove="${tableEscape(table.name)}">Remove</button>`
      : '';
    const feeds = table.feeds && SHEET_FEED_LABELS[table.feeds] ? `<div class="sheet-table-feeds" data-sheet-table-feeds>Feeds Leave: ${tableEscape(SHEET_FEED_LABELS[table.feeds])}</div>` : '';
    return `<div class="sheet-table" data-sheet-table="${tableEscape(table.name)}"><div class="sheet-table-head"><strong>${tableEscape(table.name)}</strong><span class="sheet-table-tab">tab ${tableEscape(table.tabName || '(missing)')}</span></div>${feeds}<div class="sheet-table-columns">${columns}</div><div class="sheet-table-state">${published}</div><div class="sheet-table-actions">${actions}</div></div>`;
  }).join('');
  const empty = tables.length ? '' : `<p class="sheet-empty">No tables yet.${canEdit ? ' A table turns one tab into data the rest of the app can read.' : ''}</p>`;
  return `<div class="modal-header"><h3>Tables</h3><button class="modal-close" type="button" data-sheet-tables-close aria-label="Close">&times;</button></div><div class="modal-body"><p class="drawing-share-note">A table is a tab whose first row is the header and whose columns have a type. Publish checks every row and saves it; the rest of the app reads only what was published.</p>${rows}${empty}${canEdit ? '<button type="button" class="btn primary" data-sheet-table-new>New table</button>' : ''}<div class="sheet-table-result" data-sheet-table-result></div></div>`;
}

// draft: { name, tabId, columns: [{ name, type, required }], isNew, feeds }; canFeed: may this person connect the table to Leave
function sheetTableFormHtml({ tabs, draft, canFeed = false }) {
  const tabOptions = tabs.map((tab) => `<option value="${tableEscape(tab.id)}"${tab.id === draft.tabId ? ' selected' : ''}>${tableEscape(tab.name)}</option>`).join('');
  const feedSelect = canFeed
    ? `<label class="poll-field-label" for="table-feeds">Use this table in Leave</label><select id="table-feeds" class="poll-field" data-table-feeds>${SHEET_FEED_KINDS.map(([value, label]) => `<option value="${value}"${(draft.feeds || '') === value ? ' selected' : ''}>${label}</option>`).join('')}</select><p class="drawing-share-note">Leave only changes when you Publish and confirm the preview. Choosing one fills in the columns it needs.</p>`
    : '';
  const columns = (draft.columns || []).map((column, index) => `<div class="sheet-column-row"><input type="text" class="poll-field" data-table-column-name="${index}" maxlength="60" placeholder="Column name" aria-label="Column name" value="${tableEscape(column.name)}"><select data-table-column-type="${index}" aria-label="Type">${SHEET_COLUMN_TYPES.map(([value, label]) => `<option value="${value}"${value === column.type ? ' selected' : ''}>${label}</option>`).join('')}</select><label class="sheet-column-required"><input type="checkbox" data-table-column-required="${index}"${column.required ? ' checked' : ''}> required</label><button type="button" class="poll-remove" data-table-column-remove="${index}" title="Remove column" aria-label="Remove column">&times;</button></div>`).join('');
  return `<div class="modal-header"><h3>${draft.isNew ? 'New table' : 'Edit table'}</h3><button class="modal-close" type="button" data-sheet-tables-close aria-label="Close">&times;</button></div><div class="modal-body"><label class="poll-field-label" for="table-name">Table name</label><input id="table-name" type="text" class="poll-field" data-table-name maxlength="40" placeholder="holidays" value="${tableEscape(draft.name)}"${draft.isNew ? '' : ' readonly'}><p class="drawing-share-note">Lowercase letters, digits and underscores, starting with a letter. This is the name other parts of the app use.</p><label class="poll-field-label" for="table-tab">Tab</label><select id="table-tab" class="poll-field" data-table-tab>${tabOptions}</select>${feedSelect}<div class="poll-field-label">Columns, in the order of the sheet's columns A, B, C...</div>${columns}<div class="sheet-column-tools"><button type="button" class="poll-add-option" data-table-add-column>+ Add column</button><button type="button" class="btn small" data-table-from-header>Use the header row of the tab</button></div></div><div class="modal-footer"><button type="button" class="btn" data-sheet-tables-back>Cancel</button><button type="button" class="btn primary" data-table-save>Save table</button></div>`;
}

// The answer of a check or a failed publish.
function sheetProblemsHtml({ ok, rowCount, problems, problemCount }) {
  if (ok) return `<div class="sheet-check ok">All good: ${Number(rowCount)} row${Number(rowCount) === 1 ? ' is' : 's are'} good.</div>`;
  const items = problems.map((problem) => `<li>Row ${Number(problem.row)}${problem.column ? `, ${tableEscape(problem.column)}` : ''}: ${tableEscape(problem.message)}</li>`).join('');
  const more = problemCount > problems.length ? `<li>... and ${problemCount - problems.length} more</li>` : '';
  return `<div class="sheet-check bad"><strong>${Number(problemCount)} problem${Number(problemCount) === 1 ? '' : 's'}: nothing is published until they are fixed.</strong><ul>${items}${more}</ul></div>`;
}

// The preview of a table that feeds Leave: what Publish would change, shown before anything is applied.
function sheetFeedPreviewHtml({ feeds, name, preview }) {
  const list = (items) => `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
  const e = tableEscape;
  const years = preview.years.map(Number).join(', ');
  let body;
  let empty;
  if (feeds === 'holidays') {
    empty = !preview.add.length && !preview.rename.length && !preview.remove.length;
    body = (preview.add.length ? `<div class="sheet-feed-group"><strong>Add (${preview.add.length})</strong>${list(preview.add.map((h) => `${e(h.day)} ${e(h.name)}`))}</div>` : '')
      + (preview.rename.length ? `<div class="sheet-feed-group"><strong>Rename (${preview.rename.length})</strong>${list(preview.rename.map((h) => `${e(h.day)} ${e(h.from)} &rarr; ${e(h.to)}`))}</div>` : '')
      + (preview.remove.length ? `<div class="sheet-feed-group sheet-feed-remove"><strong class="sheet-feed-danger">Remove (${preview.remove.length})</strong> <span class="sheet-table-tab">not in the sheet</span>${list(preview.remove.map((h) => `${e(h.day)} ${e(h.name)}`))}</div>` : '');
  } else {
    empty = !preview.set.length && !preview.reset.length;
    body = (preview.set.length ? `<div class="sheet-feed-group"><strong>Set (${preview.set.length})</strong>${list(preview.set.map((c) => `<strong>${e(c.username)}</strong>: ${e(c.typeName)} ${Number(c.year)}: ${Number(c.previous)} to ${Number(c.adjustment)}`))}</div>` : '')
      + (preview.reset.length ? `<div class="sheet-feed-group sheet-feed-remove"><strong class="sheet-feed-danger">Back to the default (${preview.reset.length})</strong> <span class="sheet-table-tab">not in the sheet</span>${list(preview.reset.map((c) => `<strong>${e(c.username)}</strong>: ${e(c.typeName)} ${Number(c.year)}: ${Number(c.previous)} to none`))}</div>` : '');
  }
  const heading = empty ? `No change to Leave for ${years}` : `Publishing will change Leave for ${years}`;
  const same = preview.unchanged ? `<p class="sheet-table-state">${Number(preview.unchanged)} stay the same.</p>` : '';
  return `<div class="sheet-feed-preview" data-sheet-feed-preview><h4>${heading}</h4>${body}${same}<div class="sheet-table-actions"><button type="button" class="btn" data-sheet-feed-cancel>Cancel</button><button type="button" class="btn primary" data-sheet-feed-apply="${e(name)}">${empty ? 'Publish' : 'Apply and publish'}</button></div></div>`;
}

// The first row of a tab as text columns, up to the first empty cell (a repeated name is dropped).
function columnsFromHeader(header) {
  const columns = [];
  const seen = new Set();
  for (const cell of header || []) {
    const name = String(cell || '').trim();
    if (!name) break;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    columns.push({ name: name.slice(0, 60), type: 'text', required: false });
    if (columns.length >= SHEET_TABLE_MAX_COLUMNS) break;
  }
  return columns;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sheetTablesHtml, sheetTableFormHtml, sheetProblemsHtml, columnsFromHeader, feedColumnsFit, feedColumnsFor, sheetFeedPreviewHtml, SHEET_COLUMN_TYPES };
}
