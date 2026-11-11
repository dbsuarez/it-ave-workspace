// Real PostgreSQL: the move from fixed to-do items to typed rows. Skipped when no database is reachable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch;
let client;

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  client = await scratch.open();
});
test.after(async () => {
  if (client) await client.end();
  if (scratch) await scratch.drop();
});

test('init.sql plus migrations build a working schema, and re-running them is harmless', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  await scratch.applyInit(client);
  await scratch.applyMigrations(client);
  await scratch.applyMigrations(client); // idempotent
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
     AND table_name IN ('list_columns', 'list_rows', 'list_cells', 'schema_markers')`
  );
  assert.equal(tables.rows.length, 4);
});

test('existing to-do items become typed rows with their ids, values and timestamps intact', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  // Start from the state before typed lists: a database with old-style items and nothing else.
  const old = await createScratchDatabase();
  const legacy = await old.open();
  try {
    await old.applyInit(legacy);
    // init.sql now also contains the new tables and the one-off move; undo that to recreate the old state
    await legacy.query("DELETE FROM schema_markers WHERE name = 'lists_typed_v1'");
    await legacy.query('DELETE FROM list_cells; DELETE FROM list_rows; DELETE FROM list_columns');
    await legacy.query(`INSERT INTO users (username, email, password_hash) VALUES ('u1', 'u1@x.test', 'x'), ('u2', 'u2@x.test', 'x')`);
    const users = (await legacy.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    // init.sql already seeds the default channels
    const channelId = (await legacy.query('SELECT id FROM channels ORDER BY id LIMIT 1')).rows[0].id;
    await legacy.query(`INSERT INTO channel_lists (channel_id, title, created_by) VALUES ($1, 'Launch', $2), ($1, 'Empty', $2)`, [channelId, users[0]]);
    const lists = (await legacy.query('SELECT id FROM channel_lists ORDER BY id')).rows.map((r) => r.id);
    await legacy.query(
      `INSERT INTO channel_list_items (id, list_id, title, is_completed, assignee_id, due_date, created_by, created_at)
       VALUES (41, $1, 'Write plan', TRUE, $2, '2026-03-04', $2, '2026-01-02T03:04:05Z'),
              (57, $1, 'Ship it', FALSE, NULL, NULL, $2, '2026-01-03T00:00:00Z')`,
      [lists[0], users[1]]
    );

    await old.applyMigrations(legacy);

    const columns = await legacy.query('SELECT list_id, key, type, is_primary FROM list_columns ORDER BY list_id, position');
    assert.equal(columns.rows.length, 8, 'both lists get the four to-do columns');
    assert.deepEqual(columns.rows.filter((c) => c.list_id === lists[1]).map((c) => c.key), ['title', 'completed', 'assignee', 'due_date'], 'even an empty list');
    assert.equal(columns.rows.filter((c) => c.is_primary).length, 2, 'exactly one primary per list');

    const rows = await legacy.query('SELECT id, list_id, created_at FROM list_rows ORDER BY id');
    assert.deepEqual(rows.rows.map((r) => r.id), [41, 57], 'row ids equal the old item ids');
    assert.equal(rows.rows[0].created_at.toISOString(), '2026-01-02T03:04:05.000Z');

    const cells = await legacy.query(
      `SELECT r.id, c.key, x.value FROM list_cells x
       JOIN list_rows r ON r.id = x.row_id JOIN list_columns c ON c.id = x.column_id ORDER BY r.id, c.position`
    );
    const asMap = (id) => Object.fromEntries(cells.rows.filter((r) => r.id === id).map((r) => [r.key, r.value]));
    assert.deepEqual(asMap(41), { title: 'Write plan', completed: true, assignee: [users[1]], due_date: '2026-03-04' });
    assert.deepEqual(asMap(57), { title: 'Ship it' }, 'unset values are simply absent');

    // New rows continue after the highest old id instead of colliding with it
    const next = await legacy.query(`INSERT INTO list_rows (list_id) VALUES ($1) RETURNING id`, [lists[0]]);
    assert.ok(next.rows[0].id > 57, `next id ${next.rows[0].id} follows the migrated ids`);

    // The move happens once: delete a row, re-run the migrations, and it must not come back
    await legacy.query('DELETE FROM list_rows WHERE id = 57');
    await old.applyMigrations(legacy);
    const again = await legacy.query('SELECT id FROM list_rows WHERE id = 57');
    assert.equal(again.rows.length, 0, 'a deleted row is not resurrected from the old table');
  } finally {
    await legacy.end();
    await old.drop();
  }
});
