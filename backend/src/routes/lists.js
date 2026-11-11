const express = require('express');
const router = express.Router();
const { query, pool } = require('../db');
const poolDb = { query }; // store functions take anything with .query(), the pool or a transaction client
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership } = require('../security');
const { ensureNotGuest } = require('../guests');
const store = require('../listsStore');
const {
  COLUMN_TYPES, normalizeColumnOptions, normalizeCellValue, validateColumnName, parseDate,
} = require('../listValues');

const MAX_COLUMNS = 50;
const MAX_CELL_EDITS = 100;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseTitle(value, maxLength) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title.length > 0 && title.length <= maxLength ? title : null;
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function handleError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// ---- shapes ---------------------------------------------------------------------------------

const mapList = (l) => ({
  id: l.id, channelId: l.channel_id, title: l.title, description: l.description, todoMode: l.todo_mode,
  createdAt: l.created_at, updatedAt: l.updated_at,
});
const mapColumn = (c) => ({
  id: c.id, key: c.key, name: c.name, type: c.type, options: c.options, isPrimary: c.is_primary, position: c.position,
});
const mapRow = (r) => ({
  id: r.id, parentId: r.parent_row_id, position: r.position, cells: r.cells,
  createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

// The to-do shape the first version of the desktop client reads (title, completed, assignee, due date).
const byKey = (columns) => Object.fromEntries(columns.map((c) => [c.key, c]));

function legacyItem(row, columns, names) {
  const cols = byKey(columns);
  const cell = (key) => (cols[key] ? row.cells[cols[key].id] : undefined);
  const assignee = cell('assignee');
  const assigneeId = Array.isArray(assignee) && assignee.length > 0 ? assignee[0] : null;
  return {
    id: row.id,
    title: cell('title') || '',
    completed: cell('completed') === true,
    assigneeId,
    assigneeName: assigneeId === null ? null : (names.get(assigneeId) || null),
    dueDate: cell('due_date') || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function usernamesFor(db, rowsByList) {
  const ids = new Set();
  for (const rows of rowsByList) {
    for (const row of rows) {
      for (const value of Object.values(row.cells)) {
        // Only the first element of a user cell is read by the legacy shape, but collect all cheaply.
        if (Array.isArray(value)) value.forEach((v) => { if (Number.isInteger(v)) ids.add(v); });
      }
    }
  }
  if (ids.size === 0) return new Map();
  const result = await db.query('SELECT id, username FROM users WHERE id = ANY($1::int[])', [[...ids]]);
  return new Map(result.rows.map((u) => [u.id, u.username]));
}

// ---- access ---------------------------------------------------------------------------------

async function loadList(userId, listId, { write = false } = {}) {
  const list = await store.getList(poolDb, listId);
  if (!list || list.archived_at) throw fail(404, 'List not found');
  await ensureChannelMembership(query, userId, list.channel_id);
  // Guests are read-only in lists (decision 4 of the Lists/Canvas plan).
  if (write) await ensureNotGuest(query, userId, 'Guests have view-only access to lists');
  return list;
}

const memberCheck = (channelId) => async (userId) => {
  const result = await query('SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);
  return result.rows.length > 0;
};

// { "<column id or key>": value } -> { columnId: normalizedValue }. Unknown columns are errors.
async function normalizeCellInput(columns, input, channelId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'cells must be an object of column to value');
  const entries = Object.entries(input);
  if (entries.length > MAX_CELL_EDITS) throw fail(400, `At most ${MAX_CELL_EDITS} cells can be changed at once`);
  const out = {};
  const ctx = { isChannelMember: memberCheck(channelId) };
  for (const [ref, raw] of entries) {
    const column = columns.find((c) => String(c.id) === ref || c.key === ref);
    if (!column) throw fail(400, `Unknown column "${ref}"`);
    if (Object.hasOwn(out, column.id)) throw fail(400, `Column "${column.name}" was given twice`);
    out[column.id] = await normalizeCellValue(column, raw, ctx);
  }
  return out;
}

// ---- collection -------------------------------------------------------------------------------

router.get('/', authenticateToken, async (req, res) => {
  try {
    const channelId = req.query.channelId === undefined ? null : parseId(req.query.channelId);
    if (req.query.channelId !== undefined && channelId === null) {
      return res.status(400).json({ error: 'A valid channel ID is required' });
    }
    if (channelId !== null) await ensureChannelMembership(query, req.user.userId, channelId);

    const listResult = await query(
      `SELECT l.id, l.channel_id, l.title, l.description, l.todo_mode, l.created_at, l.updated_at, c.name AS channel_name
       FROM channel_lists l
       JOIN channels c ON c.id = l.channel_id
       JOIN channel_members member ON member.channel_id = l.channel_id
       WHERE member.user_id = $1 AND ($2::int IS NULL OR l.channel_id = $2) AND l.archived_at IS NULL
       ORDER BY l.created_at DESC, l.id DESC`,
      [req.user.userId, channelId]
    );
    const ids = listResult.rows.map((l) => l.id);
    const columns = await store.getColumnsForLists(poolDb, ids);
    const rows = await store.getRowsForLists(poolDb, ids);
    const names = await usernamesFor(poolDb, rows.values());

    const lists = listResult.rows.map((l) => {
      const cols = columns.get(l.id);
      const hasTodoShape = cols.some((c) => c.key === 'title');
      return {
        id: l.id,
        channelId: l.channel_id,
        channelName: l.channel_name,
        title: l.title,
        description: l.description,
        todoMode: l.todo_mode,
        createdAt: l.created_at,
        updatedAt: l.updated_at,
        items: hasTodoShape ? rows.get(l.id).map((row) => legacyItem(row, cols, names)) : [],
      };
    });

    let members = [];
    if (channelId !== null) {
      const memberResult = await query(
        `SELECT u.id, u.username FROM channel_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = $1 ORDER BY u.username`,
        [channelId]
      );
      members = memberResult.rows.map((m) => ({ id: m.id, username: m.username }));
    }
    res.json({ lists, members });
  } catch (err) {
    handleError(res, err, 'Get lists error');
  }
});

// Create a list. Without `todoMode: false` it is a to-do list (title, completed, assignee, due date),
// exactly what older clients create. A table list starts with one primary text column plus any
// `columns` given as [{ name, type, options }].
router.post('/', authenticateToken, async (req, res) => {
  try {
    const body = bodyOf(req);
    const channelId = parseId(body.channelId);
    const title = parseTitle(body.title, 120);
    if (channelId === null) return res.status(400).json({ error: 'A valid channel ID is required' });
    if (!title) return res.status(400).json({ error: 'List title must be between 1 and 120 characters' });
    const todoMode = body.todoMode !== false;
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';
    await ensureChannelMembership(query, req.user.userId, channelId);
    await ensureNotGuest(query, req.user.userId, 'Guests have view-only access to lists');

    // Validate the requested columns before anything is written.
    const extra = [];
    if (!todoMode && body.columns !== undefined) {
      if (!Array.isArray(body.columns) || body.columns.length > MAX_COLUMNS - 1) throw fail(400, `columns must be a list of at most ${MAX_COLUMNS - 1} columns`);
      for (const raw of body.columns) {
        if (!raw || !COLUMN_TYPES.includes(raw.type)) throw fail(400, `Column type must be one of: ${COLUMN_TYPES.join(', ')}`);
        extra.push({ name: validateColumnName(raw.name), type: raw.type, options: normalizeColumnOptions(raw.type, raw.options) });
      }
    }
    const primaryName = todoMode ? 'Title' : validateColumnName(body.primaryName === undefined ? 'Name' : body.primaryName);

    const created = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO channel_lists (channel_id, title, description, todo_mode, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [channelId, title, description, todoMode, req.user.userId]
      );
      const listId = inserted.rows[0].id;
      if (todoMode) {
        for (const def of store.TODO_COLUMNS) {
          await store.insertColumn(client, listId, { name: def.name, type: def.type, options: def.options, key: def.key, isPrimary: def.is_primary });
        }
      } else {
        await store.insertColumn(client, listId, { name: primaryName, type: 'text', key: 'title', isPrimary: true });
        for (const def of extra) await store.insertColumn(client, listId, def);
      }
      return listId;
    });
    const list = await store.getList(poolDb, created);
    const columns = await store.getColumns(poolDb, created);
    res.status(201).json({ list: { ...mapList(list), items: [] }, columns: columns.map(mapColumn) });
  } catch (err) {
    handleError(res, err, 'Create list error');
  }
});

// ---- one list ---------------------------------------------------------------------------------

router.get('/:listId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    const list = await loadList(req.user.userId, listId);
    const columns = await store.getColumns(poolDb, listId);
    const limit = req.query.limit === undefined ? 500 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw fail(400, 'limit must be a whole number from 1 to 5000');
    const page = await store.getRowsPage(poolDb, listId, {
      archived: req.query.archived === 'true',
      limit,
      cursor: typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null,
    });
    const members = await query(
      `SELECT u.id, u.username FROM channel_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = $1 ORDER BY u.username`,
      [list.channel_id]
    );
    res.json({
      list: mapList(list),
      columns: columns.map(mapColumn),
      rows: page.rows.map(mapRow),
      nextCursor: page.nextCursor,
      members: members.rows.map((m) => ({ id: m.id, username: m.username })),
    });
  } catch (err) {
    handleError(res, err, 'Get list error');
  }
});

router.patch('/:listId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    await loadList(req.user.userId, listId, { write: true });
    const body = bodyOf(req);
    const title = Object.hasOwn(body, 'title') ? parseTitle(body.title, 120) : null;
    if (Object.hasOwn(body, 'title') && !title) {
      return res.status(400).json({ error: 'List title must be between 1 and 120 characters' });
    }
    const description = Object.hasOwn(body, 'description')
      ? (typeof body.description === 'string' ? body.description.trim().slice(0, 500) : null) : null;
    if (Object.hasOwn(body, 'description') && description === null) {
      return res.status(400).json({ error: 'Description must be text' });
    }
    if (title === null && description === null) return res.status(400).json({ error: 'List title must be between 1 and 120 characters' });
    const result = await query(
      `UPDATE channel_lists SET title = COALESCE($1, title), description = COALESCE($2, description), updated_at = NOW()
       WHERE id = $3 RETURNING ${'id, channel_id, title, description, todo_mode, created_at, updated_at'}`,
      [title, description, listId]
    );
    const list = result.rows[0];
    res.json({ list: { id: list.id, channelId: list.channel_id, title: list.title, description: list.description, updatedAt: list.updated_at } });
  } catch (err) {
    handleError(res, err, 'Update list error');
  }
});

router.delete('/:listId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    await loadList(req.user.userId, listId, { write: true });
    await query('DELETE FROM channel_lists WHERE id = $1', [listId]);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Delete list error');
  }
});

// Copy a list: same columns, and its rows too unless includeRows is false. Optionally into another
// channel you belong to.
router.post('/:listId/copy', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    const source = await loadList(req.user.userId, listId);
    await ensureNotGuest(query, req.user.userId, 'Guests have view-only access to lists');
    const body = bodyOf(req);
    const title = body.title === undefined ? parseTitle(`Copy of ${source.title}`.slice(0, 120), 120) : parseTitle(body.title, 120);
    if (!title) return res.status(400).json({ error: 'List title must be between 1 and 120 characters' });
    const channelId = body.channelId === undefined ? source.channel_id : parseId(body.channelId);
    if (channelId === null) return res.status(400).json({ error: 'A valid channel ID is required' });
    if (channelId !== source.channel_id) await ensureChannelMembership(query, req.user.userId, channelId);
    const newId = await withTransaction((client) => store.copyList(client, source, {
      title, channelId, includeRows: body.includeRows !== false, userId: req.user.userId,
    }));
    const list = await store.getList(poolDb, newId);
    const columns = await store.getColumns(poolDb, newId);
    res.status(201).json({ list: { ...mapList(list), items: [] }, columns: columns.map(mapColumn) });
  } catch (err) {
    handleError(res, err, 'Copy list error');
  }
});

// ---- columns ----------------------------------------------------------------------------------

router.post('/:listId/columns', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    await loadList(req.user.userId, listId, { write: true });
    const body = bodyOf(req);
    const name = validateColumnName(body.name);
    if (!COLUMN_TYPES.includes(body.type)) throw fail(400, `Column type must be one of: ${COLUMN_TYPES.join(', ')}`);
    const options = normalizeColumnOptions(body.type, body.options);
    const existing = await store.getColumns(poolDb, listId);
    if (existing.length >= MAX_COLUMNS) throw fail(400, `A list can have at most ${MAX_COLUMNS} columns`);
    const column = await store.insertColumn(poolDb, listId, { name, type: body.type, options });
    res.status(201).json({ column: mapColumn(column) });
  } catch (err) {
    handleError(res, err, 'Create column error');
  }
});

router.patch('/:listId/columns/:columnId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    const columnId = parseId(req.params.columnId);
    if (listId === null || columnId === null) return res.status(400).json({ error: 'Valid list and column IDs are required' });
    await loadList(req.user.userId, listId, { write: true });
    const columns = await store.getColumns(poolDb, listId);
    const column = columns.find((c) => c.id === columnId);
    if (!column) throw fail(404, 'Column not found');
    const body = bodyOf(req);
    if (Object.hasOwn(body, 'type') && body.type !== column.type) throw fail(400, 'A column\'s type cannot be changed');
    const name = Object.hasOwn(body, 'name') ? validateColumnName(body.name) : column.name;
    const options = Object.hasOwn(body, 'options') ? normalizeColumnOptions(column.type, body.options) : column.options;

    const updated = await withTransaction(async (client) => {
      const result = await client.query(
        'UPDATE list_columns SET name = $1, options = $2::jsonb WHERE id = $3 AND list_id = $4 RETURNING id, list_id, key, name, type, options, is_primary, position',
        [name, JSON.stringify(options), columnId, listId]
      );
      // Choices that were removed disappear from the cells that used them.
      if (column.type === 'select' && Object.hasOwn(body, 'options')) {
        const keep = new Set(options.choices.map((c) => c.id));
        const cells = await client.query('SELECT row_id, value FROM list_cells WHERE column_id = $1', [columnId]);
        for (const cell of cells.rows) {
          const kept = (cell.value || []).filter((id) => keep.has(id));
          if (kept.length === cell.value.length) continue;
          if (kept.length === 0) await client.query('DELETE FROM list_cells WHERE row_id = $1 AND column_id = $2', [cell.row_id, columnId]);
          else await client.query('UPDATE list_cells SET value = $3::jsonb WHERE row_id = $1 AND column_id = $2', [cell.row_id, columnId, JSON.stringify(kept)]);
        }
      }
      return result.rows[0];
    });
    res.json({ column: mapColumn(updated) });
  } catch (err) {
    handleError(res, err, 'Update column error');
  }
});

router.delete('/:listId/columns/:columnId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    const columnId = parseId(req.params.columnId);
    if (listId === null || columnId === null) return res.status(400).json({ error: 'Valid list and column IDs are required' });
    await loadList(req.user.userId, listId, { write: true });
    const columns = await store.getColumns(poolDb, listId);
    const column = columns.find((c) => c.id === columnId);
    if (!column) throw fail(404, 'Column not found');
    if (column.is_primary) throw fail(400, 'The primary column cannot be deleted');
    await query('DELETE FROM list_columns WHERE id = $1 AND list_id = $2', [columnId, listId]);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Delete column error');
  }
});

// ---- rows -------------------------------------------------------------------------------------

router.post('/:listId/rows', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    const list = await loadList(req.user.userId, listId, { write: true });
    const columns = await store.getColumns(poolDb, listId);
    const body = bodyOf(req);
    let cells = await normalizeCellInput(columns, body.cells ?? {}, list.channel_id);

    // duplicateOf: start from another row's cells (and keep its parent); anything in `cells` overrides
    let parentId = null;
    if (body.duplicateOf !== undefined) {
      const sourceId = parseId(body.duplicateOf);
      const source = sourceId === null ? null : await store.getRow(poolDb, listId, sourceId);
      if (!source) throw fail(404, 'The row to duplicate was not found in this list');
      parentId = source.parent_row_id;
      cells = { ...source.cells, ...cells };
    }
    // parentId: make this a subtask. Subtasks are one level deep.
    if (body.parentId !== undefined && body.parentId !== null) {
      const wanted = parseId(body.parentId);
      const parent = wanted === null ? null : await store.getRow(poolDb, listId, wanted);
      if (!parent || parent.archived_at) throw fail(404, 'The parent row was not found in this list');
      if (parent.parent_row_id !== null) throw fail(400, 'Subtasks cannot have subtasks');
      parentId = parent.id;
    }
    const primary = columns.find((c) => c.is_primary);
    if (!primary || cells[primary.id] === undefined || cells[primary.id] === null) {
      throw fail(400, `"${primary ? primary.name : 'The primary column'}" is required`);
    }
    const rowId = await withTransaction(async (client) => {
      const row = await store.insertRow(client, listId, req.user.userId, parentId);
      await store.writeCells(client, row.id, cells);
      return row.id;
    });
    const row = await store.getRow(poolDb, listId, rowId);
    res.status(201).json({ row: mapRow(row) });
  } catch (err) {
    handleError(res, err, 'Create row error');
  }
});

// Change up to 100 cells of one row in a single transaction: all of them apply, or none do.
router.patch('/:listId/rows/:rowId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    const rowId = parseId(req.params.rowId);
    if (listId === null || rowId === null) return res.status(400).json({ error: 'Valid list and row IDs are required' });
    const list = await loadList(req.user.userId, listId, { write: true });
    if (!(await store.getRow(poolDb, listId, rowId))) throw fail(404, 'Row not found');
    const columns = await store.getColumns(poolDb, listId);
    const body = bodyOf(req);
    if (body.archived !== undefined && typeof body.archived !== 'boolean') throw fail(400, 'archived must be true or false');
    const input = body.cells;
    if (input === undefined && body.archived === undefined) throw fail(400, 'No cell changes provided');
    const cells = input === undefined ? {} : await normalizeCellInput(columns, input, list.channel_id);
    if (input !== undefined && Object.keys(cells).length === 0 && body.archived === undefined) throw fail(400, 'No cell changes provided');
    await withTransaction(async (client) => {
      if (Object.keys(cells).length > 0) await store.writeCells(client, rowId, cells);
      await store.touchRow(client, rowId, req.user.userId);
      if (body.archived !== undefined) await store.setArchived(client, listId, rowId, body.archived, req.user.userId);
    });
    res.json({ row: mapRow(await store.getRow(poolDb, listId, rowId)) });
  } catch (err) {
    handleError(res, err, 'Update row error');
  }
});

router.delete('/:listId/rows/:rowId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    const rowId = parseId(req.params.rowId);
    if (listId === null || rowId === null) return res.status(400).json({ error: 'Valid list and row IDs are required' });
    await loadList(req.user.userId, listId, { write: true });
    const result = await query('DELETE FROM list_rows WHERE id = $1 AND list_id = $2', [rowId, listId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Row not found' });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Delete row error');
  }
});

// ---- to-do items: the original endpoints, now backed by rows and cells ------------------------

function parseDueDate(value) {
  if (value === null || value === '' || value === undefined) return { valid: true, value: null };
  const date = parseDate(value);
  return { valid: date !== null, value: date };
}

async function ensureAssigneeMembership(channelId, assigneeId) {
  if (assigneeId === null) return;
  if (!(await memberCheck(channelId)(assigneeId))) throw fail(400, 'Assignee must be a member of this channel');
}

function todoColumnsOf(columns) {
  const cols = byKey(columns);
  if (!cols.title) throw fail(400, 'This list has no Title column; use the rows API');
  return cols;
}

async function itemResponse(listId, rowId, columns) {
  const row = await store.getRow(poolDb, listId, rowId);
  const names = await usernamesFor(poolDb, [[row]]);
  return legacyItem(row, columns, names);
}

router.post('/:listId/items', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    const list = await loadList(req.user.userId, listId, { write: true });
    const columns = await store.getColumns(poolDb, listId);
    const cols = todoColumnsOf(columns);

    const body = bodyOf(req);
    const title = parseTitle(body.title, 200);
    const hasAssignee = body.assigneeId !== null && body.assigneeId !== '' && body.assigneeId !== undefined;
    const assigneeId = hasAssignee ? parseId(body.assigneeId) : null;
    const dueDate = parseDueDate(body.dueDate);
    if (!title) return res.status(400).json({ error: 'Item title must be between 1 and 200 characters' });
    if (hasAssignee && assigneeId === null) return res.status(400).json({ error: 'A valid assignee ID is required' });
    if (!dueDate.valid) return res.status(400).json({ error: 'Due date must be a valid YYYY-MM-DD date' });
    await ensureAssigneeMembership(list.channel_id, assigneeId);

    const cells = { [cols.title.id]: title };
    if (assigneeId !== null && cols.assignee) cells[cols.assignee.id] = [assigneeId];
    if (dueDate.value && cols.due_date) cells[cols.due_date.id] = dueDate.value;
    const rowId = await withTransaction(async (client) => {
      const row = await store.insertRow(client, listId, req.user.userId);
      await store.writeCells(client, row.id, cells);
      return row.id;
    });
    res.status(201).json({ item: await itemResponse(listId, rowId, columns) });
  } catch (err) {
    handleError(res, err, 'Create list item error');
  }
});

router.patch('/:listId/items/:itemId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    const itemId = parseId(req.params.itemId);
    if (listId === null || itemId === null) return res.status(400).json({ error: 'Valid list and item IDs are required' });
    const list = await loadList(req.user.userId, listId, { write: true });
    if (!(await store.getRow(poolDb, listId, itemId))) return res.status(404).json({ error: 'List item not found' });
    const columns = await store.getColumns(poolDb, listId);
    const cols = todoColumnsOf(columns);

    const body = bodyOf(req);
    const cells = {};
    let changes = 0;
    if (Object.hasOwn(body, 'title')) {
      const title = parseTitle(body.title, 200);
      if (!title) return res.status(400).json({ error: 'Item title must be between 1 and 200 characters' });
      cells[cols.title.id] = title;
      changes += 1;
    }
    if (Object.hasOwn(body, 'completed')) {
      if (typeof body.completed !== 'boolean') return res.status(400).json({ error: 'Completed must be true or false' });
      if (cols.completed) cells[cols.completed.id] = body.completed ? true : null;
      changes += 1;
    }
    if (Object.hasOwn(body, 'assigneeId')) {
      const cleared = body.assigneeId === null || body.assigneeId === '';
      const assigneeId = cleared ? null : parseId(body.assigneeId);
      if (!cleared && assigneeId === null) return res.status(400).json({ error: 'A valid assignee ID is required' });
      await ensureAssigneeMembership(list.channel_id, assigneeId);
      if (cols.assignee) cells[cols.assignee.id] = assigneeId === null ? null : [assigneeId];
      changes += 1;
    }
    if (Object.hasOwn(body, 'dueDate')) {
      const dueDate = parseDueDate(body.dueDate);
      if (!dueDate.valid) return res.status(400).json({ error: 'Due date must be a valid YYYY-MM-DD date' });
      if (cols.due_date) cells[cols.due_date.id] = dueDate.value;
      changes += 1;
    }
    if (changes === 0) return res.status(400).json({ error: 'No item changes provided' });

    await withTransaction(async (client) => {
      await store.writeCells(client, itemId, cells);
      await store.touchRow(client, itemId, req.user.userId);
    });
    res.json({ item: await itemResponse(listId, itemId, columns) });
  } catch (err) {
    handleError(res, err, 'Update list item error');
  }
});

router.delete('/:listId/items/:itemId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    const itemId = parseId(req.params.itemId);
    if (listId === null || itemId === null) return res.status(400).json({ error: 'Valid list and item IDs are required' });
    await loadList(req.user.userId, listId, { write: true });
    const result = await query('DELETE FROM list_rows WHERE id = $1 AND list_id = $2', [itemId, listId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'List item not found' });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Delete list item error');
  }
});

module.exports = router;
