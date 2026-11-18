// Sheets API (docs/superpowers/specs/2026-11-19-sheets-design.md). Creating needs the Manage sheets permission; everything else
// depends on the person's role on that sheet (owner, editor, viewer). Saves carry the revision they were based on.
const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { can } = require('../permissions');
const sheets = require('../sheets');

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
    res.json({ sheets: rows.map((row) => sheets.serializeSheet(row, row.role, { tabCount: row.tab_count })) });
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

module.exports = router;
