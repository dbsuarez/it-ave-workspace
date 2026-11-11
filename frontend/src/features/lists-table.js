// IT Avenue Workspace - Lists: table view.
//
// Loaded before renderer.js. A "table" list has typed columns (text, checkbox, date, number, link,
// select, user) and rows with inline-editable cells, subtasks, archive, duplicate, sorting and a
// filter. To-do lists keep the original checklist card (renderer.js). Everything here goes through
// /api/lists/:id and its columns/rows endpoints; all values are validated again on the server.

const LIST_COLUMN_TYPES = [
  ['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['checkbox', 'Checkbox'],
  ['select', 'Select'], ['user', 'Person'], ['link', 'Link'],
];
const LIST_STARTER_COLUMNS = [
  { name: 'Status', type: 'select', options: { choices: [{ label: 'Not started', color: 'gray' }, { label: 'In progress', color: 'blue' }, { label: 'Done', color: 'green' }] } },
  { name: 'Owner', type: 'user', options: {} },
  { name: 'Due date', type: 'date', options: {} },
];

// listId -> { list, columns, rows, members, nextCursor, archived, sort: {columnId, dir}, filter, adding }
const listTables = {};

function tlCard(listId) {
  return document.querySelector(`[data-table-list="${listId}"]`);
}

function tlColumn(table, columnId) {
  return table.columns.find((column) => Number(column.id) === Number(columnId));
}

async function loadListTable(listId, { more = false } = {}) {
  const card = tlCard(listId);
  const table = listTables[listId] || (listTables[listId] = { columns: [], rows: [], members: [], nextCursor: null, archived: false, sort: null, filter: '', adding: false });
  try {
    const cursor = more && table.nextCursor ? `&cursor=${encodeURIComponent(table.nextCursor)}` : '';
    const res = await api(`/api/lists/${listId}?limit=500${table.archived ? '&archived=true' : ''}${cursor}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the list');
    table.list = data.list;
    table.columns = data.columns;
    table.members = data.members;
    table.rows = more ? table.rows.concat(data.rows) : data.rows;
    table.nextCursor = data.nextCursor;
    renderListTable(listId);
  } catch (err) {
    console.error('Load list table error:', err);
    if (card) card.innerHTML = '<p class="shared-list-empty">Could not load this list.</p>';
  }
}

// ---- cell display and editing -------------------------------------------------------------------

function tlChoice(column, id) {
  return (column.options?.choices || []).find((choice) => choice.id === id);
}

function tlChipsHtml(table, column, row, editable = true) {
  const value = Array.isArray(row.cells[column.id]) ? row.cells[column.id] : [];
  const multiple = column.options?.multiple === true;
  const chips = value.map((entry) => {
    const label = column.type === 'select'
      ? (tlChoice(column, entry)?.label || '?')
      : (table.members.find((m) => Number(m.id) === Number(entry))?.username || `user ${entry}`);
    const color = column.type === 'select' ? (tlChoice(column, entry)?.color || 'gray') : 'indigo';
    const remove = editable ? `<button type="button" class="tl-chip-x" data-tl-unpick="${row.id}:${column.id}:${escapeHtml(String(entry))}" aria-label="Remove ${escapeHtml(label)}">×</button>` : '';
    return `<span class="tl-chip c-${escapeHtml(color)}">${escapeHtml(label)}${remove}</span>`;
  }).join('');
  const options = column.type === 'select'
    ? (column.options?.choices || []).filter((c) => !value.includes(c.id)).map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`)
    : table.members.filter((m) => !value.includes(m.id)).map((m) => `<option value="${m.id}">${escapeHtml(m.username)}</option>`);
  const showPicker = editable && options.length > 0 && (multiple || value.length === 0);
  const picker = showPicker
    ? `<select class="tl-pick" data-tl-pick="${row.id}:${column.id}" aria-label="Add ${escapeHtml(column.name)}"><option value="">${value.length ? '+' : '—'}</option>${options.join('')}</select>`
    : '';
  return `<div class="tl-chips">${chips}${picker}</div>`;
}

function tlCellHtml(table, column, row) {
  const value = row.cells[column.id];
  const id = `data-tl-cell="${row.id}:${column.id}"`;
  const label = `aria-label="${escapeHtml(column.name)}"`;
  const readOnly = table.archived ? ' disabled' : '';
  switch (column.type) {
    case 'checkbox':
      return `<input type="checkbox" ${id} ${label}${value === true ? ' checked' : ''}${readOnly}>`;
    case 'date':
      return `<input type="date" class="tl-input" ${id} ${label} value="${escapeHtml(value || '')}"${readOnly}>`;
    case 'number':
      return `<input type="number" class="tl-input tl-number" step="any" ${id} ${label} value="${value === undefined || value === null ? '' : escapeHtml(String(value))}"${readOnly}>`;
    case 'link': {
      const url = value && value.url ? value.url : '';
      return `<span class="tl-link"><input type="url" class="tl-input" ${id} ${label} value="${escapeHtml(url)}" placeholder="https://"${readOnly}>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open link" title="Open link">↗</a>` : ''}</span>`;
    }
    case 'select':
    case 'user':
      return tlChipsHtml(table, column, row, !table.archived);
    default:
      return `<input type="text" class="tl-input${column.isPrimary ? ' tl-primary' : ''}" ${id} ${label} value="${escapeHtml(value || '')}" maxlength="${column.isPrimary ? 200 : 2000}"${readOnly}>`;
  }
}

// A sortable plain-text form of a cell, also used by the filter.
function tlPlain(table, column, row) {
  const value = row.cells[column.id];
  if (value === undefined || value === null) return '';
  if (column.type === 'select') return (value || []).map((id) => tlChoice(column, id)?.label || '').join(', ');
  if (column.type === 'user') return (value || []).map((id) => table.members.find((m) => Number(m.id) === Number(id))?.username || '').join(', ');
  if (column.type === 'link') return value.url || '';
  return String(value);
}

function tlOrderedRows(table) {
  const needle = table.filter.trim().toLowerCase();
  const matches = (row) => table.columns.some((column) => tlPlain(table, column, row).toLowerCase().includes(needle));
  const parents = table.rows.filter((row) => row.parentId === null);
  const childrenOf = (id) => table.rows.filter((row) => row.parentId === id);
  let ordered = parents;
  if (table.sort) {
    const column = tlColumn(table, table.sort.columnId);
    if (column) {
      const key = (row) => {
        const raw = tlPlain(table, column, row);
        return column.type === 'number' ? (raw === '' ? Number.POSITIVE_INFINITY : Number(raw)) : raw.toLowerCase();
      };
      ordered = [...parents].sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        return (ka < kb ? -1 : ka > kb ? 1 : 0) * (table.sort.dir === 'desc' ? -1 : 1);
      });
    }
  }
  const out = [];
  for (const parent of ordered) {
    const kids = childrenOf(parent.id);
    if (needle && !matches(parent) && !kids.some(matches)) continue;
    out.push(parent, ...kids);
  }
  // Subtasks whose parent is not on this page (archived parent, later page) still show.
  for (const row of table.rows) {
    if (row.parentId !== null && !parents.some((p) => p.id === row.parentId)) out.push(row);
  }
  return out;
}

function tlRowHtml(table, row) {
  const cells = table.columns.map((column) => `<td class="tl-td tl-type-${column.type}">${tlCellHtml(table, column, row)}</td>`).join('');
  const sub = row.parentId !== null;
  const actions = table.archived
    ? `<button type="button" class="tl-act" data-tl-restore="${row.id}" title="Restore">Restore</button><button type="button" class="tl-act danger" data-tl-delete-row="${row.id}" title="Delete" aria-label="Delete row">×</button>`
    : `${sub ? '' : `<button type="button" class="tl-act" data-tl-subtask="${row.id}" title="Add a subtask" aria-label="Add a subtask">+ Sub</button>`}<button type="button" class="tl-act" data-tl-duplicate="${row.id}" title="Duplicate" aria-label="Duplicate row">Copy</button><button type="button" class="tl-act" data-tl-archive="${row.id}" title="Archive" aria-label="Archive row">Archive</button><button type="button" class="tl-act danger" data-tl-delete-row="${row.id}" title="Delete" aria-label="Delete row">×</button>`;
  return `<tr class="tl-row${sub ? ' tl-subtask' : ''}" data-tl-row="${row.id}">${cells}<td class="tl-td tl-actions">${actions}</td></tr>`;
}

function renderListTable(listId) {
  const card = tlCard(listId);
  const table = listTables[listId];
  if (!card || !table || !table.list) return;
  const typeName = (type) => (LIST_COLUMN_TYPES.find((t) => t[0] === type) || [type, type])[1];
  const head = table.columns.map((column) => {
    const active = table.sort && Number(table.sort.columnId) === Number(column.id);
    const arrow = active ? (table.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const tools = column.isPrimary ? '' : `<span class="tl-col-tools"><button type="button" data-tl-rename-col="${column.id}" title="Rename column" aria-label="Rename column">✎</button><button type="button" data-tl-delete-col="${column.id}" title="Delete column" aria-label="Delete column">×</button></span>`;
    return `<th class="tl-th"><button type="button" class="tl-sort" data-tl-sort="${column.id}" title="Sort by ${escapeHtml(column.name)}">${escapeHtml(column.name)}<span class="tl-type">${escapeHtml(typeName(column.type))}</span>${arrow}</button>${tools}</th>`;
  }).join('');
  const rows = tlOrderedRows(table).map((row) => tlRowHtml(table, row)).join('');
  const empty = table.rows.length === 0
    ? `<tr><td class="tl-empty" colspan="${table.columns.length + 1}">${table.archived ? 'Nothing archived.' : 'No rows yet. Add the first one below.'}</td></tr>`
    : '';
  const topLevel = table.rows.filter((r) => r.parentId === null).length;
  card.innerHTML = `
    <div class="shared-list-card-header">
      <div>
        <h2>${escapeHtml(table.list.title)}</h2>
        <span class="meta">${topLevel} ${topLevel === 1 ? 'row' : 'rows'}${table.archived ? ' archived' : ''}${table.nextCursor ? ' (more available)' : ''}</span>
      </div>
      <div class="tl-toolbar">
        <input type="search" class="tl-filter" data-tl-filter placeholder="Filter rows" aria-label="Filter rows" value="${escapeHtml(table.filter)}">
        <button class="btn-list-delete" type="button" data-tl-toggle-archived>${table.archived ? 'Back to list' : 'Archived'}</button>
        <button class="btn-list-delete" type="button" data-tl-copy-list>Copy list</button>
        <button class="btn-list-delete" type="button" data-tl-delete-list>Delete</button>
      </div>
    </div>
    <div class="tl-scroll">
      <table class="tl-table">
        <thead><tr>${head}<th class="tl-th tl-th-actions"></th></tr></thead>
        <tbody>${rows}${empty}</tbody>
      </table>
    </div>
    ${table.nextCursor ? '<button type="button" class="btn" data-tl-more>Load more rows</button>' : ''}
    ${table.archived ? '' : `
    <form class="tl-add-row" data-tl-add-row>
      <input type="text" name="title" maxlength="200" required placeholder="Add a row" aria-label="New row title">
      <button class="btn primary" type="submit">Add</button>
      <button class="btn" type="button" data-tl-add-col-toggle>+ Column</button>
    </form>
    <form class="tl-add-col" data-tl-add-col${table.adding ? '' : ' hidden'}>
      <input type="text" name="name" maxlength="80" required placeholder="Column name" aria-label="Column name">
      <select name="type" aria-label="Column type">${LIST_COLUMN_TYPES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
      <input type="text" name="choices" class="tl-choices" placeholder="Choices, separated by commas" aria-label="Choices" hidden>
      <label class="tl-multi" hidden><input type="checkbox" name="multiple"> several</label>
      <button class="btn primary" type="submit">Add column</button>
    </form>`}`;
}

// ---- server calls -------------------------------------------------------------------------------

async function tlApi(listId, path, method, body) {
  const res = await api(`/api/lists/${listId}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function tlFail(err, label) {
  console.error(label, err);
  showToast(err.message || label, 'error');
}

async function tlSetCell(listId, rowId, columnId, value) {
  const table = listTables[listId];
  try {
    const data = await tlApi(listId, `/rows/${rowId}`, 'PATCH', { cells: { [columnId]: value } });
    const index = table.rows.findIndex((row) => Number(row.id) === Number(rowId));
    if (index !== -1) table.rows[index] = data.row;
  } catch (err) {
    tlFail(err, 'Could not save the change.');
  }
  // Redraw just this row so keyboard focus in the neighbouring cells survives.
  const tr = tlCard(listId)?.querySelector(`[data-tl-row="${rowId}"]`);
  const row = table.rows.find((r) => Number(r.id) === Number(rowId));
  if (tr && row) tr.outerHTML = tlRowHtml(table, row);
}

function tlValueFromInput(column, input) {
  if (column.type === 'checkbox') return input.checked;
  const raw = input.value.trim();
  if (raw === '') return null;
  if (column.type === 'number') return Number(raw);
  return raw;
}

async function tlAddColumn(listId, form) {
  const data = new FormData(form);
  const type = data.get('type');
  const body = { name: String(data.get('name') || '').trim(), type, options: {} };
  if (type === 'select') {
    body.options = {
      multiple: data.get('multiple') === 'on',
      choices: String(data.get('choices') || '').split(',').map((label) => label.trim()).filter(Boolean).map((label) => ({ label })),
    };
  } else if (type === 'user') {
    body.options = { multiple: data.get('multiple') === 'on' };
  }
  try {
    await tlApi(listId, '/columns', 'POST', body);
    listTables[listId].adding = false;
    await loadListTable(listId);
  } catch (err) {
    tlFail(err, 'Could not add the column.');
  }
}

// ---- events (delegated on the lists container) ---------------------------------------------------

function tlParse(value) {
  return value.split(':');
}

async function handleListTableClick(event) {
  const card = event.target.closest('[data-table-list]');
  if (!card) return;
  const listId = Number(card.dataset.tableList);
  const table = listTables[listId];
  if (!table) return;
  const hit = (selector) => event.target.closest(selector);
  let target;

  if ((target = hit('[data-tl-sort]'))) {
    const columnId = Number(target.dataset.tlSort);
    if (!table.sort || table.sort.columnId !== columnId) table.sort = { columnId, dir: 'asc' };
    else if (table.sort.dir === 'asc') table.sort.dir = 'desc';
    else table.sort = null;
    renderListTable(listId);
  } else if (hit('[data-tl-more]')) {
    await loadListTable(listId, { more: true });
  } else if (hit('[data-tl-toggle-archived]')) {
    table.archived = !table.archived;
    table.rows = [];
    table.nextCursor = null;
    await loadListTable(listId);
  } else if (hit('[data-tl-add-col-toggle]')) {
    table.adding = !table.adding;
    card.querySelector('[data-tl-add-col]').hidden = !table.adding;
    if (table.adding) card.querySelector('[data-tl-add-col] [name=name]').focus();
  } else if ((target = hit('[data-tl-unpick]'))) {
    const [rowId, columnId, entry] = tlParse(target.dataset.tlUnpick);
    const row = table.rows.find((r) => Number(r.id) === Number(rowId));
    const kept = (row.cells[columnId] || []).filter((v) => String(v) !== entry);
    await tlSetCell(listId, rowId, columnId, kept.length ? kept : null);
  } else if ((target = hit('[data-tl-subtask]'))) {
    const title = await askText('Subtask', { placeholder: 'What needs doing?', maxLength: 200, required: true });
    if (!title) return;
    try {
      await tlApi(listId, '/rows', 'POST', { parentId: Number(target.dataset.tlSubtask), cells: { title } });
      await loadListTable(listId);
    } catch (err) { tlFail(err, 'Could not add the subtask.'); }
  } else if ((target = hit('[data-tl-duplicate]'))) {
    try {
      await tlApi(listId, '/rows', 'POST', { duplicateOf: Number(target.dataset.tlDuplicate), cells: {} });
      await loadListTable(listId);
    } catch (err) { tlFail(err, 'Could not duplicate the row.'); }
  } else if ((target = hit('[data-tl-archive]')) || (target = hit('[data-tl-restore]'))) {
    const rowId = Number(target.dataset.tlArchive || target.dataset.tlRestore);
    try {
      await tlApi(listId, `/rows/${rowId}`, 'PATCH', { archived: Boolean(target.dataset.tlArchive) });
      await loadListTable(listId);
    } catch (err) { tlFail(err, 'Could not update the row.'); }
  } else if ((target = hit('[data-tl-delete-row]'))) {
    if (!(await confirmAction({ title: 'Delete this row?', message: 'The row and its subtasks will be permanently deleted.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await tlApi(listId, `/rows/${Number(target.dataset.tlDeleteRow)}`, 'DELETE');
      await loadListTable(listId);
    } catch (err) { tlFail(err, 'Could not delete the row.'); }
  } else if ((target = hit('[data-tl-rename-col]'))) {
    const column = tlColumn(table, target.dataset.tlRenameCol);
    const name = await askText('Column name', { placeholder: column.name, maxLength: 80, required: true });
    if (!name) return;
    try {
      await tlApi(listId, `/columns/${column.id}`, 'PATCH', { name });
      await loadListTable(listId);
    } catch (err) { tlFail(err, 'Could not rename the column.'); }
  } else if ((target = hit('[data-tl-delete-col]'))) {
    const column = tlColumn(table, target.dataset.tlDeleteCol);
    if (!(await confirmAction({ title: `Delete "${column.name}"?`, message: 'Everything stored in this column is deleted too.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await tlApi(listId, `/columns/${column.id}`, 'DELETE');
      await loadListTable(listId);
    } catch (err) { tlFail(err, 'Could not delete the column.'); }
  } else if (hit('[data-tl-copy-list]')) {
    const name = await askText('Name for the copy', { placeholder: `Copy of ${table.list.title}`, maxLength: 120 });
    if (name === null) return;
    try {
      await tlApi(listId, '/copy', 'POST', name ? { title: name } : {});
      await loadLists();
      showToast('List copied.', 'success');
    } catch (err) { tlFail(err, 'Could not copy the list.'); }
  } else if (hit('[data-tl-delete-list]')) {
    if (!(await confirmAction({ title: 'Delete list', message: `Delete "${table.list.title}" and all its rows?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await tlApi(listId, '', 'DELETE');
      await loadLists();
    } catch (err) { tlFail(err, 'Could not delete the list.'); }
  }
}

async function handleListTableChange(event) {
  const card = event.target.closest('[data-table-list]');
  if (!card) return;
  const listId = Number(card.dataset.tableList);
  const table = listTables[listId];
  if (!table) return;
  const input = event.target;
  if (input.dataset.tlCell) {
    const [rowId, columnId] = tlParse(input.dataset.tlCell);
    const column = tlColumn(table, columnId);
    const value = tlValueFromInput(column, input);
    const row = table.rows.find((r) => Number(r.id) === Number(rowId));
    if (column.isPrimary && value === null) {
      showToast(`"${column.name}" cannot be empty.`, 'error');
      input.value = row.cells[columnId] || '';
      return;
    }
    await tlSetCell(listId, rowId, columnId, value);
  } else if (input.dataset.tlPick) {
    if (!input.value) return;
    const [rowId, columnId] = tlParse(input.dataset.tlPick);
    const column = tlColumn(table, columnId);
    const row = table.rows.find((r) => Number(r.id) === Number(rowId));
    const picked = column.type === 'user' ? Number(input.value) : input.value;
    const current = Array.isArray(row.cells[columnId]) ? row.cells[columnId] : [];
    await tlSetCell(listId, rowId, columnId, column.options?.multiple ? [...current, picked] : [picked]);
  } else if (input.name === 'type' && input.closest('[data-tl-add-col]')) {
    const form = input.closest('form');
    form.querySelector('.tl-choices').hidden = input.value !== 'select';
    form.querySelector('.tl-multi').hidden = !(input.value === 'select' || input.value === 'user');
  }
}

async function handleListTableSubmit(event) {
  const card = event.target.closest('[data-table-list]');
  if (!card) return;
  event.preventDefault();
  const listId = Number(card.dataset.tableList);
  if (event.target.matches('[data-tl-add-row]')) {
    const input = event.target.querySelector('[name=title]');
    const title = input.value.trim();
    if (!title) return;
    try {
      await tlApi(listId, '/rows', 'POST', { cells: { title } });
      await loadListTable(listId);
      tlCard(listId)?.querySelector('[data-tl-add-row] [name=title]')?.focus();
    } catch (err) { tlFail(err, 'Could not add the row.'); }
  } else if (event.target.matches('[data-tl-add-col]')) {
    await tlAddColumn(listId, event.target);
  }
}

function handleListTableInput(event) {
  if (!event.target.matches('[data-tl-filter]')) return;
  const card = event.target.closest('[data-table-list]');
  const table = listTables[Number(card.dataset.tableList)];
  if (!table) return;
  table.filter = event.target.value;
  const caret = event.target.selectionStart;
  renderListTable(Number(card.dataset.tableList));
  const again = card.querySelector('[data-tl-filter]');
  again.focus();
  again.setSelectionRange(caret, caret);
}

(function bindListTable() {
  const container = document.getElementById('lists-container');
  if (!container) return;
  container.addEventListener('click', handleListTableClick);
  container.addEventListener('change', handleListTableChange);
  container.addEventListener('submit', handleListTableSubmit);
  container.addEventListener('input', handleListTableInput);
}());
