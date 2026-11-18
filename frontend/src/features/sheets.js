// IT Avenue Workspace - the Sheets screen: the list, and an open sheet in a spreadsheet grid that saves by itself.
// Markup comes from sheets-view.js, merging from sheet-merge.js, and the grid (Jspreadsheet CE) from vendor/sheet-grid.js, which is
// loaded the first time a sheet is opened so it does not slow the app's start. Loaded before renderer.js, which calls setupSheets().

const sheetsState = {
  scope: 'mine', canCreate: false,
  open: null, // { id, sheet, revision, base } while a sheet is open
  grid: null, status: 'saved', saveTimer: null, retryTimer: null, saving: false, again: false, editorReady: null,
};

const SHEET_SAVE_DELAY_MS = 1500;
const SHEET_RETRY_MS = 5000;

async function sheetJson(path, options) {
  const response = await api(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: response.status, data });
  return data;
}

// Loads the grid script and its stylesheets once, from the app's own files.
function ensureSheetGrid() {
  if (sheetsState.editorReady) return sheetsState.editorReady;
  sheetsState.editorReady = new Promise((resolve, reject) => {
    for (const name of ['jsuites.css', 'jspreadsheet.css']) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `vendor/sheet-assets/${name}`;
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = 'vendor/sheet-grid.js';
    script.onload = () => resolve();
    script.onerror = () => { sheetsState.editorReady = null; reject(new Error('The spreadsheet could not be loaded.')); };
    document.head.appendChild(script);
  });
  return sheetsState.editorReady;
}

// ------------------------------------------------------------------------------------------------------------------- the list
async function loadSheetsList() {
  const list = document.getElementById('sheets-list');
  if (!list) return;
  try {
    const data = await sheetJson(`/api/sheets?scope=${sheetsState.scope}`);
    sheetsState.canCreate = Boolean(data.canCreate);
    const newButton = document.getElementById('btn-sheets-new');
    if (newButton) newButton.hidden = !sheetsState.canCreate;
    const leaveButton = document.getElementById('btn-sheets-leave');
    if (leaveButton) leaveButton.hidden = !sheetsState.canCreate;
    const sheets = (data.sheets || []).map((sheet) => ({ ...sheet, updatedText: forumRelativeTime(sheet.updatedAt) }));
    list.innerHTML = sheetListHtml(sheets, {
      empty: sheetsState.scope === 'mine'
        ? (sheetsState.canCreate ? 'No sheets yet. Press New sheet to make one.' : 'You have not made any sheets.')
        : 'Nothing has been shared with you yet.',
    });
  } catch (err) { list.innerHTML = `<p class="sheet-empty">${sheetEscape(err.message || 'Could not load the sheets.')}</p>`; }
}

async function showSheetsHome() {
  document.getElementById('sheets-editor').hidden = true;
  document.getElementById('sheets-home').hidden = false;
  document.querySelectorAll('[data-sheets-scope]').forEach((button) => {
    const on = button.dataset.sheetsScope === sheetsState.scope;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  });
  await loadSheetsList();
}

async function startNewSheet() {
  const asked = await askText('Name this sheet', { placeholder: 'Untitled sheet', maxLength: 120 });
  if (asked === null) return;
  try {
    const data = await sheetJson('/api/sheets', { method: 'POST', body: JSON.stringify({ title: asked.trim() || 'Untitled sheet' }) });
    await openSheet(data.sheet.id);
  } catch (err) { showToast(err.message || 'Could not make the sheet.', 'error'); }
}

// A sheet to start from: a copy of the current and upcoming leave (HR only: the leave records are). Not a live link.
async function newSheetFromLeave() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const records = await sheetJson(`/api/leave/records?from=${today}`);
    const rows = leaveRecordsToRows(records.requests || []);
    const created = await sheetJson('/api/sheets', { method: 'POST', body: JSON.stringify({ title: `Leave records ${today}`, data: { tabs: [{ name: 'Leave', rows }] } }) });
    if (records.truncated) showToast('Only the first 500 leave records were copied.', 'info');
    await openSheet(created.sheet.id);
  } catch (err) { showToast(err.status === 403 ? 'Only HR can copy the leave records.' : (err.message || 'Could not copy the leave records.'), 'error'); }
}

// ------------------------------------------------------------------------------------------------------------ an open sheet
function renderSheetBar() {
  const open = sheetsState.open;
  const host = document.getElementById('sheet-bar-host');
  if (!open || !host) return;
  host.innerHTML = sheetBarHtml({ sheet: open.sheet, status: open.sheet.role === 'viewer' ? 'viewing' : sheetsState.status, isOwner: open.isOwner });
}

function setSheetStatus(status) {
  sheetsState.status = status;
  renderSheetBar();
}

function showSheetNotice(text) {
  const host = document.getElementById('sheet-banner-host');
  if (host) host.innerHTML = text ? `<div class="sheet-banner" role="status">${sheetEscape(text)}</div>` : '';
}

async function openSheet(id) {
  try {
    await ensureSheetGrid();
    if (sheetsState.open) await closeSheet();
    const data = await sheetJson(`/api/sheets/${id}`);
    sheetsState.open = { id: Number(id), sheet: data.sheet, revision: data.sheet.revision, base: data.data, isOwner: data.members !== undefined };
    sheetsState.status = 'saved';
    document.getElementById('sheets-home').hidden = true;
    document.getElementById('sheets-editor').hidden = false;
    renderSheetBar();
    showSheetNotice(data.sheet.role === 'viewer' ? 'You can look at this sheet but not change it.' : '');
    const host = document.getElementById('sheet-grid');
    host.innerHTML = '';
    sheetsState.grid = ITASheet.mount(host, { tabs: data.data.tabs, readOnly: data.sheet.role === 'viewer', onChange: markSheetChanged });
  } catch (err) { showToast(err.message || 'Could not open the sheet.', 'error'); }
}

function markSheetChanged() {
  const open = sheetsState.open;
  if (!open || open.sheet.role !== 'editor') return;
  setSheetStatus('unsaved');
  clearTimeout(sheetsState.saveTimer);
  sheetsState.saveTimer = setTimeout(saveSheetNow, SHEET_SAVE_DELAY_MS);
}

// Saves what is on screen. If someone else saved first, their version comes back and my edits are merged into it (sheet-merge.js).
async function saveSheetNow() {
  clearTimeout(sheetsState.saveTimer);
  clearTimeout(sheetsState.retryTimer);
  const open = sheetsState.open;
  if (!open || !sheetsState.grid || open.sheet.role !== 'editor') return;
  if (sheetsState.saving) { sheetsState.again = true; return; }
  const mine = { tabs: sheetsState.grid.getTabs() };
  if (sheetsEqual(mine, open.base)) { setSheetStatus('saved'); return; }
  sheetsState.saving = true;
  setSheetStatus('saving');
  try {
    const saved = await sheetJson(`/api/sheets/${open.id}/data`, { method: 'PUT', body: JSON.stringify({ baseRevision: open.revision, data: mine }) });
    open.revision = saved.revision;
    open.base = saved.data;
    setSheetStatus('saved');
  } catch (err) {
    if (err.status === 409 && err.data && err.data.data) {
      const merged = mergeSheetData(open.base, mine, err.data.data);
      open.base = err.data.data;
      open.revision = err.data.revision;
      sheetsState.grid.setTabs(merged.data.tabs);
      showSheetNotice(`Someone else saved this sheet while you were editing. Their changes were merged with yours${merged.collisions ? ` (${merged.collisions} cell${merged.collisions === 1 ? '' : 's'} you both changed kept your value)` : ''}.`);
      sheetsState.again = true;
    } else {
      setSheetStatus('error');
      sheetsState.retryTimer = setTimeout(saveSheetNow, SHEET_RETRY_MS);
    }
  } finally {
    sheetsState.saving = false;
    if (sheetsState.again) { sheetsState.again = false; sheetsState.saveTimer = setTimeout(saveSheetNow, 100); }
  }
}

async function closeSheet() {
  clearTimeout(sheetsState.retryTimer);
  if (sheetsState.open && sheetsState.status !== 'saved') await saveSheetNow();
  if (sheetsState.grid) sheetsState.grid.destroy();
  sheetsState.grid = null;
  sheetsState.open = null;
  showSheetNotice('');
  document.getElementById('sheet-grid').innerHTML = '';
  await showSheetsHome();
}

async function renameOpenSheet() {
  const open = sheetsState.open;
  if (!open) return;
  const title = await askText('New title', { placeholder: open.sheet.title, maxLength: 120, required: true });
  if (title === null || !title.trim() || title.trim() === open.sheet.title) return;
  try {
    const data = await sheetJson(`/api/sheets/${open.id}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) });
    open.sheet = data.sheet;
    renderSheetBar();
  } catch (err) { showToast(err.message || 'Could not rename it.', 'error'); }
}

// ---- CSV in and out ----
function downloadSheetFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportSheetCsv() {
  const open = sheetsState.open;
  if (!open || !sheetsState.grid) return;
  const tabs = sheetsState.grid.getTabs();
  const tab = tabs[sheetsState.grid.activeIndex()] || tabs[0];
  // a byte order mark so Excel reads accents and other languages correctly
  downloadSheetFile(new Blob([`\uFEFF${rowsToCsv(tab.rows)}`], { type: 'text/csv;charset=utf-8' }), csvFileName(open.sheet.title, tab.name));
}

async function importSheetCsv(file) {
  if (!file || !sheetsState.grid) return;
  if (file.size > 5 * 1024 * 1024) { showToast('That file is too large (the limit is 5 MB).', 'error'); return; }
  const rows = parseCsv(await file.text());
  if (!rows.length) { showToast('There is nothing in that file to import.', 'info'); return; }
  if (rows.length > 5000 || rows.some((row) => row.length > 200)) { showToast('A tab can have at most 5000 rows and 200 columns.', 'error'); return; }
  const tabs = sheetsState.grid.getTabs();
  const base = file.name.replace(/\.[^.]*$/, '').slice(0, 28).trim() || 'Imported';
  let name = base;
  for (let n = 2; tabs.some((tab) => tab.name.toLowerCase() === name.toLowerCase()); n += 1) name = `${base} ${n}`;
  if (tabs.length >= 20) { showToast('A sheet can have at most 20 tabs.', 'error'); return; }
  tabs.push({ id: `t${Math.random().toString(16).slice(2, 10)}`, name, rows });
  sheetsState.grid.setTabs(tabs);
  markSheetChanged();
  showToast(`Imported ${rows.length} row${rows.length === 1 ? '' : 's'} as a new tab.`, 'success');
}

// ---- sharing and deleting (the owner's) ----
async function openSheetShare() {
  const open = sheetsState.open;
  const modal = document.getElementById('sheet-share-modal');
  if (!open || !modal) return;
  try {
    const data = await sheetJson(`/api/sheets/${open.id}`);
    const people = (state.users || []).filter((user) => Number(user.id) !== Number(state.user.id) && user.accountType !== 'guest');
    sheetsState.share = { people: employeeOptions(people.map((user) => ({ id: user.id, name: personName(user), username: user.username }))) };
    modal.innerHTML = sheetShareHtml({ sheet: data.sheet, members: data.members || [], people: sheetsState.share.people.map((p) => p.label) });
    openSettingsModal(modal);
  } catch (err) { showToast(err.message || 'Could not open sharing.', 'error'); }
}

async function handleSheetShareClick(event) {
  const open = sheetsState.open;
  const modal = document.getElementById('sheet-share-modal');
  if (!open || !modal) return;
  const target = event.target;
  try {
    if (target.closest('[data-sheet-share-close]')) { closeSettingsModal(); return; }
    const remove = target.closest('[data-sheet-member-remove]');
    if (remove) { await sheetJson(`/api/sheets/${open.id}/members/${Number(remove.dataset.sheetMemberRemove)}`, { method: 'DELETE' }); await openSheetShare(); return; }
    if (target.closest('[data-sheet-add]')) {
      const id = headIdFromInput(modal.querySelector('[data-sheet-add-person]').value, sheetsState.share.people);
      if (!id) { showToast('Pick the person from the list.', 'error'); return; }
      await sheetJson(`/api/sheets/${open.id}/members/${id}`, { method: 'PUT', body: JSON.stringify({ role: modal.querySelector('[data-sheet-add-role]').value }) });
      await openSheetShare();
    }
  } catch (err) { showToast(err.message || 'Could not change sharing.', 'error'); }
}

async function handleSheetShareChange(event) {
  const open = sheetsState.open;
  const select = event.target.closest && event.target.closest('[data-sheet-member-role]');
  if (!open || !select) return;
  try {
    await sheetJson(`/api/sheets/${open.id}/members/${Number(select.dataset.sheetMemberRole)}`, { method: 'PUT', body: JSON.stringify({ role: select.value }) });
  } catch (err) { showToast(err.message || 'Could not change the role.', 'error'); await openSheetShare(); }
}

// ---- tables: declare a tab as a table, check it, publish it ----
const tablesState = { list: [], draft: null };

const tableModal = () => document.getElementById('sheet-tables-modal');

async function loadSheetTables() {
  const data = await sheetJson(`/api/sheets/${sheetsState.open.id}/tables`);
  tablesState.list = data.tables || [];
}

function renderSheetTables() {
  const modal = tableModal();
  tablesState.draft = null;
  modal.innerHTML = sheetTablesHtml({ tables: tablesState.list, canEdit: sheetsState.open.sheet.role === 'editor' });
}

async function openSheetTables() {
  const open = sheetsState.open;
  if (!open) return;
  try {
    if (open.sheet.role === 'editor' && sheetsState.status !== 'saved') await saveSheetNow(); // the list and the grid must agree
    await loadSheetTables();
    renderSheetTables();
    openSettingsModal(tableModal());
  } catch (err) { showToast(err.message || 'Could not open the tables.', 'error'); }
}

// The values of one tab as the grid shows them, to check or publish.
function tabValues(tabId) {
  const tab = sheetsState.grid.getValues().find((candidate) => candidate.id === tabId);
  return tab ? tab.rows : [];
}

function showTableResult(html) {
  const host = tableModal().querySelector('[data-sheet-table-result]');
  if (host) host.innerHTML = html;
}

async function checkOrPublishTable(name, publish) {
  const open = sheetsState.open;
  const table = tablesState.list.find((candidate) => candidate.name === name);
  if (!open || !table) return;
  try {
    if (sheetsState.status !== 'saved') await saveSheetNow();
    const values = tabValues(table.tabId);
    if (!publish) {
      showTableResult(sheetProblemsHtml(await sheetJson(`/api/sheets/${open.id}/tables/${name}/check`, { method: 'POST', body: JSON.stringify({ values }) })));
      return;
    }
    const done = await sheetJson(`/api/sheets/${open.id}/tables/${name}/publish`, { method: 'POST', body: JSON.stringify({ values }) });
    await loadSheetTables();
    renderSheetTables();
    showTableResult(`<div class="sheet-check ok">Published ${Number(done.rowCount)} row${done.rowCount === 1 ? '' : 's'} of <strong>${sheetEscape(name)}</strong>.</div>`);
  } catch (err) {
    if (err.data && err.data.problems) showTableResult(sheetProblemsHtml({ ok: false, rowCount: 0, problems: err.data.problems, problemCount: err.data.problemCount }));
    else showToast(err.message || 'Could not do that.', 'error');
  }
}

function renderTableForm() {
  const tabs = sheetsState.grid.getTabs().map((tab) => ({ id: tab.id, name: tab.name }));
  tableModal().innerHTML = sheetTableFormHtml({ tabs, draft: tablesState.draft });
}

function startTableForm(table) {
  const tabs = sheetsState.grid.getTabs();
  tablesState.draft = table
    ? { name: table.name, tabId: table.tabId, columns: table.columns.map((column) => ({ ...column })), isNew: false }
    : { name: '', tabId: tabs[0].id, columns: [], isNew: true };
  renderTableForm();
}

// Keeps the draft in step with what is typed (the form is not redrawn while typing).
function handleTableFormInput(event) {
  const draft = tablesState.draft;
  const target = event.target;
  if (!draft) return;
  if (target.matches('[data-table-name]')) draft.name = target.value;
  else if (target.matches('[data-table-tab]')) draft.tabId = target.value;
  else if (target.matches('[data-table-column-name]')) draft.columns[Number(target.dataset.tableColumnName)].name = target.value;
  else if (target.matches('[data-table-column-type]')) draft.columns[Number(target.dataset.tableColumnType)].type = target.value;
  else if (target.matches('[data-table-column-required]')) draft.columns[Number(target.dataset.tableColumnRequired)].required = target.checked;
}

async function handleTablesClick(event) {
  const target = event.target;
  const draft = tablesState.draft;
  try {
    if (target.closest('[data-sheet-tables-close]')) { closeSettingsModal(); return; }
    if (target.closest('[data-sheet-tables-back]')) { renderSheetTables(); return; }
    if (target.closest('[data-sheet-table-new]')) { startTableForm(null); return; }
    const edit = target.closest('[data-sheet-table-edit]');
    if (edit) { startTableForm(tablesState.list.find((table) => table.name === edit.dataset.sheetTableEdit)); return; }
    const check = target.closest('[data-sheet-table-check]');
    if (check) { await checkOrPublishTable(check.dataset.sheetTableCheck, false); return; }
    const publish = target.closest('[data-sheet-table-publish]');
    if (publish) { await checkOrPublishTable(publish.dataset.sheetTablePublish, true); return; }
    const remove = target.closest('[data-sheet-table-remove]');
    if (remove) {
      if (!(await confirmAction({ title: 'Remove this table?', message: 'The sheet keeps its cells. The published rows are removed, so anything that reads this table stops seeing them.', confirmLabel: 'Remove table' }))) return;
      await sheetJson(`/api/sheets/${sheetsState.open.id}/tables/${remove.dataset.sheetTableRemove}`, { method: 'DELETE' });
      await loadSheetTables(); renderSheetTables();
      return;
    }
    if (!draft) return;
    if (target.closest('[data-table-add-column]')) { draft.columns.push({ name: '', type: 'text', required: false }); renderTableForm(); return; }
    const dropColumn = target.closest('[data-table-column-remove]');
    if (dropColumn) { draft.columns.splice(Number(dropColumn.dataset.tableColumnRemove), 1); renderTableForm(); return; }
    if (target.closest('[data-table-from-header]')) {
      const header = (tabValues(draft.tabId)[0]) || [];
      const columns = columnsFromHeader(header);
      if (!columns.length) { showToast('The first row of that tab is empty. Type the column names there first.', 'info'); return; }
      draft.columns = columns.map((column) => ({ ...(draft.columns.find((old) => old.name.toLowerCase() === column.name.toLowerCase()) || column) }));
      renderTableForm();
      return;
    }
    if (target.closest('[data-table-save]')) {
      await sheetJson(`/api/sheets/${sheetsState.open.id}/tables/${draft.name}`, { method: 'PUT', body: JSON.stringify({ tabId: draft.tabId, columns: draft.columns }) });
      await loadSheetTables(); renderSheetTables();
    }
  } catch (err) { showToast(err.message || 'Could not do that.', 'error'); }
}

async function deleteOpenSheet() {
  const open = sheetsState.open;
  if (!open) return;
  if (!(await confirmAction({ title: 'Delete this sheet?', message: 'It is removed for everyone it was shared with. This cannot be undone.', confirmLabel: 'Delete sheet' }))) return;
  try {
    await sheetJson(`/api/sheets/${open.id}`, { method: 'DELETE' });
    sheetsState.status = 'saved'; // nothing left to save
    await closeSheet();
    showToast('Sheet deleted.', 'success');
  } catch (err) { showToast(err.message || 'Could not delete it.', 'error'); }
}

function setupSheets() {
  const csvInput = document.getElementById('sheet-csv-input');
  if (csvInput) csvInput.addEventListener('change', () => { const file = csvInput.files && csvInput.files[0]; csvInput.value = ''; importSheetCsv(file); });
  const tablesModal = tableModal();
  if (tablesModal) { tablesModal.addEventListener('click', handleTablesClick); tablesModal.addEventListener('input', handleTableFormInput); tablesModal.addEventListener('change', handleTableFormInput); }
  const shareModal = document.getElementById('sheet-share-modal');
  if (shareModal) { shareModal.addEventListener('click', handleSheetShareClick); shareModal.addEventListener('change', handleSheetShareChange); }
  document.addEventListener('click', (event) => {
    const target = event.target;
    const opener = target.closest && target.closest('[data-sheet-open]');
    if (opener) { openSheet(Number(opener.dataset.sheetOpen)); return; }
    const scope = target.closest && target.closest('[data-sheets-scope]');
    if (scope) { sheetsState.scope = scope.dataset.sheetsScope; showSheetsHome(); return; }
    if (target.closest('#btn-sheets-new')) { startNewSheet(); return; }
    if (target.closest('#btn-sheets-leave')) { newSheetFromLeave(); return; }
    if (target.closest('[data-sheet-back]')) { closeSheet(); return; }
    if (target.closest('[data-sheet-rename]')) { renameOpenSheet(); return; }
    if (target.closest('[data-sheet-tables]')) { openSheetTables(); return; }
    if (target.closest('[data-sheet-export]')) { exportSheetCsv(); return; }
    if (target.closest('[data-sheet-import]')) { document.getElementById('sheet-csv-input').click(); return; }
    if (target.closest('[data-sheet-share]')) { openSheetShare(); return; }
    if (target.closest('[data-sheet-delete]')) { deleteOpenSheet(); return; }
  });
}
