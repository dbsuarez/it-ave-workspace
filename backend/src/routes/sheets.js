// Sheets API (docs/superpowers/specs/2026-11-19-sheets-design.md). Creating needs the Manage sheets permission; everything else
// depends on the person's role on that sheet (owner, editor, viewer). Saves carry the revision they were based on.
const express = require('express');
const { query, pool } = require('../db');
const authenticateToken = require('../middleware/auth');
const { can } = require('../permissions');
const sheets = require('../sheets');
const sheetTables = require('../sheetTables');
const leaveFeeds = require('../leaveFeeds');
const leaveFeedDb = require('../leaveFeedDb');

const router = express.Router();
router.use(authenticateToken);
router.use(express.json({ limit: '6mb' })); // a sheet can be several megabytes of cells

const parseId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

const needId = (value) => {
  const id = parseId(value);
  if (!id) throw sheets.fail(400, 'A valid sheet is required');
  return id;
};

// GET ?scope=mine|shared -> { sheets: [{ id, title, ownerUsername, role, revision, updatedAt, tabCount }] }
router.get('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const scope = req.query.scope;
    if (scope !== 'mine' && scope !== 'shared') throw sheets.fail(400, 'Say which sheets: scope=mine or scope=shared');
    const rows = scope === 'mine'
      ? (await query(
        `SELECT s.id, s.title, s.owner_id, s.revision, s.created_at, s.updated_at, u.username AS owner_username, 'editor' AS role, jsonb_array_length(s.data->'tabs') AS tab_count
         FROM sheets s JOIN users u ON u.id = s.owner_id WHERE s.owner_id = $1 ORDER BY s.updated_at DESC, s.id DESC`, [userId])).rows
      : (await query(
        `SELECT s.id, s.title, s.owner_id, s.revision, s.created_at, s.updated_at, u.username AS owner_username, m.role, jsonb_array_length(s.data->'tabs') AS tab_count
         FROM sheet_members m JOIN sheets s ON s.id = m.sheet_id JOIN users u ON u.id = s.owner_id WHERE m.user_id = $1 ORDER BY s.updated_at DESC, s.id DESC`, [userId])).rows;
    res.json({ sheets: rows.map((row) => sheets.serializeSheet(row, row.role, { tabCount: row.tab_count })), canCreate: await can(query, userId, 'manage_sheets') });
  } catch (err) { sendError(res, err, 'List sheets error'); }
});

router.post('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!(await can(query, userId, 'manage_sheets'))) throw sheets.fail(403, 'You cannot create sheets');
    const title = sheets.cleanTitle(req.body && req.body.title);
    const data = req.body && req.body.data !== undefined ? sheets.cleanSheetData(req.body.data) : sheets.newSheetData();
    const created = (await query('INSERT INTO sheets (title, owner_id, data, updated_by) VALUES ($1, $2, $3::jsonb, $2) RETURNING id', [title, userId, JSON.stringify(data)])).rows[0];
    const { sheet, role } = await sheets.sheetAccess(query, userId, created.id);
    res.status(201).json({ sheet: sheets.serializeSheet(sheet, role) });
  } catch (err) { sendError(res, err, 'Create sheet error'); }
});

// POST { year } (Manage sheets): a "Holidays <year>" sheet from the holidays of the year before, moved to `year`, declared as the table
// `holidays` and, when no table feeds holidays yet, connected to Leave. -> { sheet, feeds: whether it is connected }
router.post('/holidays-from-year', async (req, res) => {
  try {
    const userId = req.user.userId;
    await needManageSheets(userId);
    const year = req.body && req.body.year;
    if (!Number.isInteger(year) || year < 2001 || year > 2100) throw sheets.fail(400, 'Choose a year from 2001 to 2100');
    const last = (await query("SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM company_holidays WHERE EXTRACT(YEAR FROM day) = $1 ORDER BY day", [year - 1])).rows;
    if (!last.length) throw sheets.fail(400, `There are no holidays in ${year - 1} to copy`);
    const rows = [['date', 'name'], ...leaveFeeds.shiftHolidays(last, year).map((h) => [h.day, h.name])];
    const data = sheets.cleanSheetData({ tabs: [{ name: 'Holidays', rows }] });
    const client = await pool.connect();
    let sheetId; let connected = false;
    try {
      await client.query('BEGIN');
      sheetId = (await client.query('INSERT INTO sheets (title, owner_id, data, updated_by) VALUES ($1, $2, $3::jsonb, $2) RETURNING id', [`Holidays ${year}`, userId, JSON.stringify(data)])).rows[0].id;
      connected = !(await client.query("SELECT 1 FROM sheet_tables WHERE feeds = 'holidays'")).rows.length;
      await client.query('INSERT INTO sheet_tables (sheet_id, name, tab_id, columns, feeds) VALUES ($1, $2, $3, $4::jsonb, $5)',
        [sheetId, 'holidays', data.tabs[0].id, JSON.stringify(leaveFeeds.FEEDS.holidays.columns), connected ? 'holidays' : null]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    const { sheet, role } = await sheets.sheetAccess(query, userId, sheetId);
    res.status(201).json({ sheet: sheets.serializeSheet(sheet, role), feeds: connected });
  } catch (err) { sendError(res, err, 'Holidays sheet error'); }
});

router.get('/:id', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { sheet, role, isOwner } = await sheets.sheetAccess(query, req.user.userId, id);
    const data = (await query('SELECT data FROM sheets WHERE id = $1', [id])).rows[0].data;
    const body = { sheet: sheets.serializeSheet(sheet, role), data };
    if (isOwner) {
      body.members = (await query(
        'SELECT m.user_id, u.username, m.role FROM sheet_members m JOIN users u ON u.id = m.user_id WHERE m.sheet_id = $1 ORDER BY u.username', [id]
      )).rows.map((row) => ({ userId: row.user_id, username: row.username, role: row.role }));
    }
    res.json(body);
  } catch (err) { sendError(res, err, 'Open sheet error'); }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { role } = await sheets.sheetAccess(query, req.user.userId, id);
    if (role !== 'editor') throw sheets.fail(403, 'You can only look at this sheet');
    const title = sheets.cleanTitle(req.body && req.body.title);
    await query('UPDATE sheets SET title = $2 WHERE id = $1', [id, title]);
    const { sheet } = await sheets.sheetAccess(query, req.user.userId, id);
    res.json({ sheet: sheets.serializeSheet(sheet, role) });
  } catch (err) { sendError(res, err, 'Rename sheet error'); }
});

// PUT { baseRevision, data }: saves the whole sheet. If someone saved since baseRevision the answer is 409 with the latest
// revision and data, so the browser can merge its changes into it and save again.
router.put('/:id/data', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { role } = await sheets.sheetAccess(query, req.user.userId, id);
    if (role !== 'editor') throw sheets.fail(403, 'You can only look at this sheet');
    const base = req.body && req.body.baseRevision;
    if (!Number.isInteger(base) || base < 1) throw sheets.fail(400, 'Say which revision this change is based on');
    const data = sheets.cleanSheetData(req.body.data);
    const saved = (await query(
      'UPDATE sheets SET data = $3::jsonb, revision = revision + 1, updated_at = NOW(), updated_by = $4 WHERE id = $1 AND revision = $2 RETURNING revision, updated_at',
      [id, base, JSON.stringify(data), req.user.userId])).rows[0];
    if (saved) return res.json({ revision: saved.revision, updatedAt: saved.updated_at, data });
    const latest = (await query('SELECT revision, data FROM sheets WHERE id = $1', [id])).rows[0];
    res.status(409).json({ error: 'Someone else saved this sheet first', revision: latest.revision, data: latest.data });
  } catch (err) { sendError(res, err, 'Save sheet error'); }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { isOwner } = await sheets.sheetAccess(query, req.user.userId, id);
    if (!isOwner) throw sheets.fail(403, 'Only the person who made a sheet can delete it');
    await query('DELETE FROM sheets WHERE id = $1', [id]);
    res.json({ removed: true });
  } catch (err) { sendError(res, err, 'Delete sheet error'); }
});

// ---- sharing (the owner's) ----
router.put('/:id/members/:userId', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { isOwner } = await sheets.sheetAccess(query, req.user.userId, id);
    if (!isOwner) throw sheets.fail(403, 'Only the owner can share a sheet');
    const userId = parseId(req.params.userId);
    const role = req.body && req.body.role;
    if (role !== 'editor' && role !== 'viewer') throw sheets.fail(400, 'The role must be editor or viewer');
    if (userId === Number(req.user.userId)) throw sheets.fail(400, 'The owner already has full access');
    const person = userId ? (await query('SELECT id, account_type FROM users WHERE id = $1 AND deactivated_at IS NULL', [userId])).rows[0] : null;
    if (!person) throw sheets.fail(404, 'Person not found');
    if (person.account_type !== 'member') throw sheets.fail(400, 'Sheets can only be shared with members');
    await query(
      `INSERT INTO sheet_members (sheet_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (sheet_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [id, userId, role]);
    res.json({ userId, role });
  } catch (err) { sendError(res, err, 'Share sheet error'); }
});

router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { isOwner } = await sheets.sheetAccess(query, req.user.userId, id);
    if (!isOwner) throw sheets.fail(403, 'Only the owner can share a sheet');
    await query('DELETE FROM sheet_members WHERE sheet_id = $1 AND user_id = $2', [id, parseId(req.params.userId) || 0]);
    res.json({ removed: true });
  } catch (err) { sendError(res, err, 'Unshare sheet error'); }
});

// ---- tables: a tab declared as a table with typed columns; Publish checks it and saves the typed rows ----
const MAX_TABLES = 30;

async function loadTable(sheetId, name) {
  const table = (await query('SELECT id, name, tab_id, columns, feeds FROM sheet_tables WHERE sheet_id = $1 AND name = $2', [sheetId, sheetTables.cleanTableName(name)])).rows[0];
  if (!table) throw sheets.fail(404, 'No table with that name in this sheet');
  return table;
}

// The usernames the person columns refer to -> Map(lowercase username -> id), looked up in one query.
async function peopleFor(columns, values) {
  const wanted = new Set();
  columns.forEach((column, index) => {
    if (column.type !== 'person') return;
    for (let r = 1; r < values.length; r += 1) {
      const text = values[r] && values[r][index] ? String(values[r][index]).trim().toLowerCase() : '';
      if (text) wanted.add(text);
    }
  });
  if (!wanted.size) return new Map();
  const rows = (await query("SELECT id, LOWER(username) AS username FROM users WHERE LOWER(username) = ANY($1::text[]) AND deactivated_at IS NULL AND account_type = 'member'", [[...wanted]])).rows;
  return new Map(rows.map((row) => [row.username, row.id]));
}

// The ordinary check, plus the extra rules of a table that feeds Leave (reported by row too).
async function runCheck(table, rawValues) {
  const values = sheets.cleanValues(rawValues);
  const result = sheetTables.validateTable(table.columns, values, { people: await peopleFor(table.columns, values) });
  if (!table.feeds || result.problemCount) return result;
  const extra = leaveFeeds.feedProblems(table.feeds, result.rows, result.rowNumbers, { leaveTypes: await leaveFeedDb.leaveTypeNames({ query }) });
  if (!extra.length) return result;
  return { rows: [], rowNumbers: [], problems: extra.slice(0, 50), problemCount: extra.length };
}

async function needManageSheets(userId) {
  if (!(await can(query, userId, 'manage_sheets'))) throw sheets.fail(403, 'Only people who can manage sheets can connect a table to Leave or publish one that feeds it');
}

router.get('/:id/tables', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { sheet } = await sheets.sheetAccess(query, req.user.userId, id);
    const data = (await query('SELECT data FROM sheets WHERE id = $1', [id])).rows[0].data;
    const rows = (await query(
      `SELECT t.name, t.tab_id, t.columns, t.feeds, t.published_at, t.published_revision, u.username AS published_by,
              CASE WHEN t.published IS NULL THEN NULL ELSE jsonb_array_length(t.published->'rows') END AS row_count
       FROM sheet_tables t LEFT JOIN users u ON u.id = t.published_by WHERE t.sheet_id = $1 ORDER BY t.name`, [id])).rows;
    res.json({
      tables: rows.map((row) => ({
        name: row.name, feeds: row.feeds, tabId: row.tab_id, tabName: (data.tabs.find((tab) => tab.id === row.tab_id) || {}).name || null, columns: row.columns,
        published: row.published_at ? { at: row.published_at, by: row.published_by || null, rowCount: row.row_count, stale: Number(row.published_revision) < Number(sheet.revision) } : null,
      })),
    });
  } catch (err) { sendError(res, err, 'List tables error'); }
});

router.put('/:id/tables/:name', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { role } = await sheets.sheetAccess(query, req.user.userId, id);
    if (role !== 'editor') throw sheets.fail(403, 'You can only look at this sheet');
    const name = sheetTables.cleanTableName(req.params.name);
    const columns = sheetTables.cleanColumns(req.body && req.body.columns);
    const data = (await query('SELECT data FROM sheets WHERE id = $1', [id])).rows[0].data;
    const tabId = req.body && req.body.tabId;
    if (typeof tabId !== 'string' || !data.tabs.some((tab) => tab.id === tabId)) throw sheets.fail(400, 'Choose one of the tabs of this sheet');
    const exists = (await query('SELECT 1 FROM sheet_tables WHERE sheet_id = $1 AND name = $2', [id, name])).rows.length > 0;
    if (!exists && (await query('SELECT COUNT(*)::int AS n FROM sheet_tables WHERE sheet_id = $1', [id])).rows[0].n >= MAX_TABLES) throw sheets.fail(400, `A sheet can have at most ${MAX_TABLES} tables`);
    // feeds: omitted keeps what the table had; null or '' lets go; 'holidays' / 'credits' connects it to Leave
    const previous = (await query('SELECT feeds FROM sheet_tables WHERE sheet_id = $1 AND name = $2', [id, name])).rows[0];
    let feeds = previous ? previous.feeds : null;
    const asked = req.body && Object.prototype.hasOwnProperty.call(req.body, 'feeds');
    if (asked) {
      feeds = req.body.feeds || null;
      if (feeds !== null) {
        await needManageSheets(req.user.userId);
        const problem = leaveFeeds.feedColumnsProblem(feeds, columns);
        if (problem) throw sheets.fail(400, problem);
      }
    } else if (feeds) {
      const problem = leaveFeeds.feedColumnsProblem(feeds, columns);
      if (problem) throw sheets.fail(400, problem);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (feeds) {
        const taken = (await client.query(
          `SELECT t.id, t.name, s.id AS sheet_id, s.title FROM sheet_tables t JOIN sheets s ON s.id = t.sheet_id
           WHERE t.feeds = $1 AND NOT (t.sheet_id = $2 AND t.name = $3)`, [feeds, id, name])).rows[0];
        if (taken && !(req.body && req.body.replace === true)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Another table already feeds ${leaveFeeds.FEEDS[feeds].label.toLowerCase()}`, takenBy: { sheetId: taken.sheet_id, title: taken.title, table: taken.name } });
        }
        if (taken) await client.query('UPDATE sheet_tables SET feeds = NULL WHERE id = $1', [taken.id]);
      }
      await client.query(
        `INSERT INTO sheet_tables (sheet_id, name, tab_id, columns, feeds) VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (sheet_id, name) DO UPDATE SET tab_id = EXCLUDED.tab_id, columns = EXCLUDED.columns, feeds = EXCLUDED.feeds`, [id, name, tabId, JSON.stringify(columns), feeds]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    res.json({ name, tabId, columns, feeds });
  } catch (err) { sendError(res, err, 'Define table error'); }
});

router.delete('/:id/tables/:name', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { role } = await sheets.sheetAccess(query, req.user.userId, id);
    if (role !== 'editor') throw sheets.fail(403, 'You can only look at this sheet');
    const table = await loadTable(id, req.params.name);
    await query('DELETE FROM sheet_tables WHERE id = $1', [table.id]);
    res.json({ removed: true });
  } catch (err) { sendError(res, err, 'Remove table error'); }
});

// POST { values } -> { ok, rowCount, problems, problemCount }: what Publish would say, without publishing.
router.post('/:id/tables/:name/check', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { role } = await sheets.sheetAccess(query, req.user.userId, id);
    if (role !== 'editor') throw sheets.fail(403, 'You can only look at this sheet');
    const result = await runCheck(await loadTable(id, req.params.name), req.body && req.body.values);
    res.json({ ok: result.problemCount === 0, rowCount: result.rows.length, problems: result.problems, problemCount: result.problemCount });
  } catch (err) { sendError(res, err, 'Check table error'); }
});

// POST { values }: checks the table and, when every row is good, saves the typed rows as the published version.
router.post('/:id/tables/:name/publish', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { role, sheet } = await sheets.sheetAccess(query, req.user.userId, id);
    if (role !== 'editor') throw sheets.fail(403, 'You can only look at this sheet');
    const table = await loadTable(id, req.params.name);
    if (table.feeds) await needManageSheets(req.user.userId);
    const result = await runCheck(table, req.body && req.body.values);
    if (result.problemCount) return res.status(400).json({ error: 'The table has problems, so nothing was published', problems: result.problems, problemCount: result.problemCount });
    const confirmed = Boolean(req.body && req.body.confirm === true);
    if (table.feeds && !confirmed) {
      return res.json({ needsConfirm: true, feeds: table.feeds, preview: await leaveFeedDb.buildPreview({ query }, table.feeds, result.rows) });
    }
    const client = await pool.connect();
    let saved; let applied = null;
    try {
      await client.query('BEGIN');
      if (table.feeds) applied = await leaveFeedDb.applyFeed(client, table.feeds, result.rows);
      saved = (await client.query(
        'UPDATE sheet_tables SET published = $2::jsonb, published_at = NOW(), published_by = $3, published_revision = $4 WHERE id = $1 RETURNING published_at',
        [table.id, JSON.stringify({ rows: result.rows }), req.user.userId, sheet.revision])).rows[0];
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    res.json({ ok: true, rowCount: result.rows.length, publishedAt: saved.published_at, ...(applied ? { applied } : {}) });
  } catch (err) { sendError(res, err, 'Publish table error'); }
});

// The published version (nothing from the sheet's unpublished edits): for people who can open the sheet.
router.get('/:id/tables/:name', async (req, res) => {
  try {
    const id = needId(req.params.id);
    await sheets.sheetAccess(query, req.user.userId, id);
    const table = await sheets.readPublishedTable(query, id, sheetTables.cleanTableName(req.params.name));
    if (!table) throw sheets.fail(404, 'Nothing has been published for this table yet');
    res.json({ name: req.params.name, ...table });
  } catch (err) { sendError(res, err, 'Read table error'); }
});

module.exports = router;
