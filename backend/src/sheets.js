// Sheets: spreadsheets HR makes in the app (docs/superpowers/specs/2026-11-19-sheets-design.md). Validation of what a person sends,
// and who may open what. A sheet is { tabs: [{ id, name, rows: [[string...]...], widths? }] }; cells are strings, and a formula is
// just text starting with "=" (it runs only in the browser; only values are ever published).
const crypto = require('crypto');

const MAX_TABS = 20;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 200;
const MAX_CELL = 5000;
const MAX_TAB_NAME = 31;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TITLE = 120;

const fail = (status, message) => Object.assign(new Error(message), { status });

function cleanTitle(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail(400, 'A sheet needs a title');
  if (value.trim().length > MAX_TITLE) throw fail(400, `A title can have at most ${MAX_TITLE} characters`);
  return value.trim();
}

const newTabId = () => `t${crypto.randomBytes(4).toString('hex')}`;

// Checks a whole sheet and returns it cleaned (every tab has an id of its own, which renaming the tab keeps).
function cleanSheetData(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.tabs)) throw fail(400, 'The sheet data must have a list of tabs');
  if (data.tabs.length < 1 || data.tabs.length > MAX_TABS) throw fail(400, `A sheet has 1 to ${MAX_TABS} tabs`);
  const names = new Set();
  const usedIds = new Set();
  const tabs = data.tabs.map((tab) => {
    if (!tab || typeof tab !== 'object') throw fail(400, 'Every tab needs a name and its rows');
    const name = typeof tab.name === 'string' ? tab.name.trim() : '';
    if (!name || name.length > MAX_TAB_NAME) throw fail(400, `A tab name is 1 to ${MAX_TAB_NAME} characters`);
    if (names.has(name.toLowerCase())) throw fail(400, 'Two tabs cannot have the same name');
    names.add(name.toLowerCase());
    if (!Array.isArray(tab.rows) || tab.rows.length > MAX_ROWS) throw fail(400, `A tab can have at most ${MAX_ROWS} rows`);
    const rows = tab.rows.map((row) => {
      if (!Array.isArray(row) || row.length > MAX_COLUMNS) throw fail(400, `A row can have at most ${MAX_COLUMNS} cells`);
      return row.map((cell) => {
        if (typeof cell !== 'string') throw fail(400, 'Every cell must be text');
        if (cell.length > MAX_CELL) throw fail(400, `A cell can have at most ${MAX_CELL} characters`);
        return cell;
      });
    });
    let id = typeof tab.id === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(tab.id) && !usedIds.has(tab.id) ? tab.id : newTabId();
    while (usedIds.has(id)) id = newTabId();
    usedIds.add(id);
    const widths = Array.isArray(tab.widths) ? tab.widths.slice(0, MAX_COLUMNS).map((w) => Math.min(1000, Math.max(20, Number(w) || 100))) : undefined;
    return widths ? { id, name, rows, widths } : { id, name, rows };
  });
  const cleaned = { tabs };
  if (Buffer.byteLength(JSON.stringify(cleaned)) > MAX_BYTES) throw fail(400, 'A sheet can be at most 5 MB');
  return cleaned;
}

const newSheetData = () => ({ tabs: [{ id: newTabId(), name: 'Sheet1', rows: [] }] });

// The person's role on a sheet: the owner and editors may change it, viewers may read it. Throws 404 / 403.
async function sheetAccess(query, userId, sheetId) {
  const sheet = (await query(
    `SELECT s.id, s.title, s.owner_id, s.revision, s.created_at, s.updated_at, u.username AS owner_username
     FROM sheets s JOIN users u ON u.id = s.owner_id WHERE s.id = $1`, [sheetId])).rows[0];
  if (!sheet) throw fail(404, 'Sheet not found');
  if (Number(sheet.owner_id) === Number(userId)) return { sheet, role: 'editor', isOwner: true };
  const member = (await query('SELECT role FROM sheet_members WHERE sheet_id = $1 AND user_id = $2', [sheetId, userId])).rows[0];
  if (!member) throw fail(403, 'You do not have access to this sheet');
  return { sheet, role: member.role, isOwner: false };
}

function serializeSheet(sheet, role, extra = {}) {
  return {
    id: Number(sheet.id), title: sheet.title, ownerId: sheet.owner_id, ownerUsername: sheet.owner_username || null,
    revision: sheet.revision, createdAt: sheet.created_at, updatedAt: sheet.updated_at, role, ...extra,
  };
}

// What the rest of the app reads: the typed rows last published for a table, or null when there are none.
// -> { columns: [{ name, type, required }], rows: [{ [column]: value }], publishedAt, publishedBy } | null
async function readPublishedTable(query, sheetId, name) {
  const row = (await query(
    `SELECT t.columns, t.published, t.published_at, u.username AS published_by
     FROM sheet_tables t LEFT JOIN users u ON u.id = t.published_by
     WHERE t.sheet_id = $1 AND t.name = $2 AND t.published IS NOT NULL`, [sheetId, name])).rows[0];
  if (!row) return null;
  return { columns: row.columns, rows: row.published.rows, publishedAt: row.published_at, publishedBy: row.published_by || null };
}

// The tab values sent for a check or a publish: rows of text, within the same limits as a sheet.
function cleanValues(values) {
  if (!Array.isArray(values) || values.length > MAX_ROWS + 1) throw fail(400, 'Send the tab as a list of rows');
  return values.map((row) => {
    if (!Array.isArray(row) || row.length > MAX_COLUMNS) throw fail(400, 'Every row must be a list of cells');
    return row.map((cell) => {
      if (typeof cell !== 'string') throw fail(400, 'Every cell must be text');
      if (cell.length > MAX_CELL) throw fail(400, `A cell can have at most ${MAX_CELL} characters`);
      return cell;
    });
  });
}

module.exports = { MAX_TITLE, fail, cleanTitle, cleanSheetData, newSheetData, sheetAccess, serializeSheet, readPublishedTable, cleanValues };
