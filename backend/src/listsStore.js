// Data access for typed Lists (columns, rows, cells). `db` is anything with query(text, params): the
// pool, or a client inside a transaction.
const { keyFromName } = require('./listValues');

// The columns a to-do list starts with. The old fixed-column items map onto these by key.
const TODO_COLUMNS = [
  { key: 'title', name: 'Title', type: 'text', options: {}, is_primary: true },
  { key: 'completed', name: 'Completed', type: 'checkbox', options: {}, is_primary: false },
  { key: 'assignee', name: 'Assignee', type: 'user', options: { multiple: false }, is_primary: false },
  { key: 'due_date', name: 'Due date', type: 'date', options: {}, is_primary: false },
];

const LIST_FIELDS = 'id, channel_id, title, description, todo_mode, created_by, created_at, updated_at, archived_at';
const COLUMN_FIELDS = 'id, list_id, key, name, type, options, is_primary, position';
const ROW_FIELDS = 'id, list_id, parent_row_id, position, archived_at, created_by, updated_by, created_at, updated_at';

async function getList(db, listId) {
  const result = await db.query(`SELECT ${LIST_FIELDS} FROM channel_lists WHERE id = $1`, [listId]);
  return result.rows[0] || null;
}

async function getColumns(db, listId) {
  const result = await db.query(
    `SELECT ${COLUMN_FIELDS} FROM list_columns WHERE list_id = $1 ORDER BY position, id`,
    [listId]
  );
  return result.rows;
}

async function getColumnsForLists(db, listIds) {
  const byList = new Map(listIds.map((id) => [id, []]));
  if (listIds.length === 0) return byList;
  const result = await db.query(
    `SELECT ${COLUMN_FIELDS} FROM list_columns WHERE list_id = ANY($1::int[]) ORDER BY list_id, position, id`,
    [listIds]
  );
  for (const column of result.rows) byList.get(column.list_id).push(column);
  return byList;
}

// Rows with their cells as { columnId: value }. Archived rows are left out unless asked for.
async function getRowsForLists(db, listIds, { archived = false, limit = 5000 } = {}) {
  const byList = new Map(listIds.map((id) => [id, []]));
  if (listIds.length === 0) return byList;
  const rows = await db.query(
    `SELECT ${ROW_FIELDS} FROM list_rows
     WHERE list_id = ANY($1::int[]) AND (archived_at IS NOT NULL) = $2
     ORDER BY list_id, position, id
     LIMIT $3`,
    [listIds, archived, limit]
  );
  const byRowId = new Map();
  for (const row of rows.rows) {
    const shaped = { ...row, cells: {} };
    byRowId.set(row.id, shaped);
    byList.get(row.list_id).push(shaped);
  }
  if (byRowId.size > 0) {
    const cells = await db.query(
      'SELECT row_id, column_id, value FROM list_cells WHERE row_id = ANY($1::int[])',
      [[...byRowId.keys()]]
    );
    for (const cell of cells.rows) byRowId.get(cell.row_id).cells[cell.column_id] = cell.value;
  }
  return byList;
}

async function getRow(db, listId, rowId) {
  const result = await db.query(`SELECT ${ROW_FIELDS} FROM list_rows WHERE id = $1 AND list_id = $2`, [rowId, listId]);
  const row = result.rows[0];
  if (!row) return null;
  const cells = await db.query('SELECT column_id, value FROM list_cells WHERE row_id = $1', [rowId]);
  return { ...row, cells: Object.fromEntries(cells.rows.map((c) => [c.column_id, c.value])) };
}

async function insertColumn(db, listId, { name, type, options = {}, key, isPrimary = false }) {
  const existing = await db.query('SELECT key FROM list_columns WHERE list_id = $1', [listId]);
  const taken = new Set(existing.rows.map((r) => r.key));
  const base = key || keyFromName(name);
  let unique = base;
  for (let n = 2; taken.has(unique); n += 1) unique = `${base.slice(0, 36)}_${n}`;
  const result = await db.query(
    `INSERT INTO list_columns (list_id, key, name, type, options, is_primary, position)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6,
             COALESCE((SELECT MAX(position) + 1 FROM list_columns WHERE list_id = $1), 0))
     RETURNING ${COLUMN_FIELDS}`,
    [listId, unique, name, type, JSON.stringify(options), isPrimary]
  );
  return result.rows[0];
}

// Writes cells: a null value clears the cell. Keys of `values` are column ids.
async function writeCells(db, rowId, values) {
  for (const [columnId, value] of Object.entries(values)) {
    if (value === null) {
      await db.query('DELETE FROM list_cells WHERE row_id = $1 AND column_id = $2', [rowId, columnId]);
    } else {
      await db.query(
        `INSERT INTO list_cells (row_id, column_id, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (row_id, column_id) DO UPDATE SET value = EXCLUDED.value`,
        [rowId, columnId, JSON.stringify(value)]
      );
    }
  }
}

async function insertRow(db, listId, userId) {
  const result = await db.query(
    `INSERT INTO list_rows (list_id, position, created_by, updated_by)
     VALUES ($1, COALESCE((SELECT MAX(position) + 1 FROM list_rows WHERE list_id = $1), 1), $2, $2)
     RETURNING ${ROW_FIELDS}`,
    [listId, userId]
  );
  return result.rows[0];
}

async function touchRow(db, rowId, userId) {
  const result = await db.query(
    'UPDATE list_rows SET updated_at = NOW(), updated_by = $2 WHERE id = $1 RETURNING updated_at, updated_by',
    [rowId, userId]
  );
  return result.rows[0];
}

module.exports = {
  TODO_COLUMNS,
  getList,
  getColumns,
  getColumnsForLists,
  getRowsForLists,
  getRow,
  insertColumn,
  writeCells,
  insertRow,
  touchRow,
};
