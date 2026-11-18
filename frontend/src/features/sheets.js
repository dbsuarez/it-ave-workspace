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

// ------------------------------------------------------------------------------------------------------------ an open sheet
function renderSheetBar() {
  const open = sheetsState.open;
  const host = document.getElementById('sheet-bar-host');
  if (!open || !host) return;
  host.innerHTML = sheetBarHtml({ sheet: open.sheet, status: open.sheet.role === 'viewer' ? 'viewing' : sheetsState.status });
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
    sheetsState.open = { id: Number(id), sheet: data.sheet, revision: data.sheet.revision, base: data.data };
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

function setupSheets() {
  document.addEventListener('click', (event) => {
    const target = event.target;
    const opener = target.closest && target.closest('[data-sheet-open]');
    if (opener) { openSheet(Number(opener.dataset.sheetOpen)); return; }
    const scope = target.closest && target.closest('[data-sheets-scope]');
    if (scope) { sheetsState.scope = scope.dataset.sheetsScope; showSheetsHome(); return; }
    if (target.closest('#btn-sheets-new')) { startNewSheet(); return; }
    if (target.closest('[data-sheet-back]')) { closeSheet(); return; }
    if (target.closest('[data-sheet-rename]')) { renameOpenSheet(); return; }
  });
}
