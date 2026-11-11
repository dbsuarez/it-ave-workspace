// Lists routes against a real PostgreSQL (a scratch database, see helpers/scratchDb.js).
// Skipped when no database is reachable.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch;
let admin;
let server;
let baseUrl;
let pool;
let config;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'lists-test-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;

  const user = async (name, accountType = 'member') => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, `${name}@x.test`, 'x', accountType]
  )).rows[0].id;
  ids.alice = await user('alice');
  ids.bob = await user('bob');
  ids.carol = await user('carol', 'guest');
  ids.dave = await user('dave'); // not in the channel
  const channel = async (name) => (await admin.query('INSERT INTO channels (name, created_by) VALUES ($1, $2) RETURNING id', [name, ids.alice])).rows[0].id;
  ids.team = await channel('team');
  ids.other = await channel('other');
  for (const member of [ids.alice, ids.bob, ids.carol]) {
    await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.team, member]);
  }
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.other, ids.dave]);

  const app = express();
  app.use(express.json());
  app.use('/api/lists', require('../src/routes/lists'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

const as = (userId) => ({
  Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`,
  'Content-Type': 'application/json',
});
const call = async (userId, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/lists${path}`, { method, headers: as(userId), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const skipIfNoDb = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

// ---- the original to-do behaviour, unchanged for older clients ----------------------------------

test('a to-do list returns channel-scoped items and member choices', async (t) => {
  if (skipIfNoDb(t)) return;
  const created = await call(ids.alice, 'POST', '', { channelId: ids.team, title: '  Launch  ' });
  assert.equal(created.status, 201);
  assert.equal(created.json.list.title, 'Launch', 'the title is trimmed');
  assert.equal(created.json.list.todoMode, true);
  const listId = created.json.list.id;
  const item = await call(ids.alice, 'POST', `/${listId}/items`, { title: 'Write plan', assigneeId: ids.bob, dueDate: '2026-03-04' });
  assert.equal(item.status, 201);
  assert.deepEqual({ ...item.json.item, createdAt: undefined, updatedAt: undefined, id: undefined }, {
    id: undefined, title: 'Write plan', completed: false, assigneeId: ids.bob, assigneeName: 'bob', dueDate: '2026-03-04', createdAt: undefined, updatedAt: undefined,
  });
  const listed = await call(ids.bob, 'GET', `?channelId=${ids.team}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.lists[0].items[0].title, 'Write plan');
  assert.deepEqual(listed.json.members.map((m) => m.username), ['alice', 'bob', 'carol']);
});

test('non-members cannot read or create channel lists', async (t) => {
  if (skipIfNoDb(t)) return;
  assert.equal((await call(ids.dave, 'GET', `?channelId=${ids.team}`)).status, 403);
  assert.equal((await call(ids.dave, 'POST', '', { channelId: ids.team, title: 'x' })).status, 403);
});

test('titles are validated', async (t) => {
  if (skipIfNoDb(t)) return;
  const bad = await call(ids.alice, 'POST', '', { channelId: ids.team, title: '   ' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /between 1 and 120/);
  assert.equal((await call(ids.alice, 'POST', '', { channelId: 'abc', title: 'x' })).status, 400);
});

test('items validate same-channel assignees and due dates', async (t) => {
  if (skipIfNoDb(t)) return;
  const { json } = await call(ids.alice, 'POST', '', { channelId: ids.team, title: 'Checks' });
  const path = `/${json.list.id}/items`;
  const outsider = await call(ids.alice, 'POST', path, { title: 'x', assigneeId: ids.dave });
  assert.equal(outsider.status, 400);
  assert.match(outsider.json.error, /member of this channel/);
  assert.equal((await call(ids.alice, 'POST', path, { title: 'x', dueDate: '2026-02-30' })).status, 400);
  assert.equal((await call(ids.alice, 'POST', path, { title: '' })).status, 400);
  const empty = await call(ids.alice, 'GET', `/${json.list.id}`);
  assert.equal(empty.json.rows.length, 0, 'rejected items left nothing behind');
});

test('completion, assignee and due date updates go through, and need a boolean', async (t) => {
  if (skipIfNoDb(t)) return;
  const list = (await call(ids.alice, 'POST', '', { channelId: ids.team, title: 'Updates' })).json.list;
  const item = (await call(ids.alice, 'POST', `/${list.id}/items`, { title: 'Do it' })).json.item;
  const base = `/${list.id}/items/${item.id}`;
  assert.equal((await call(ids.alice, 'PATCH', base, { completed: 'yes' })).status, 400);
  assert.equal((await call(ids.alice, 'PATCH', base, {})).status, 400);
  const done = await call(ids.bob, 'PATCH', base, { completed: true, assigneeId: ids.alice, dueDate: '2026-05-06' });
  assert.equal(done.status, 200);
  assert.equal(done.json.item.completed, true);
  assert.equal(done.json.item.assigneeName, 'alice');
  assert.equal(done.json.item.dueDate, '2026-05-06');
  const cleared = await call(ids.bob, 'PATCH', base, { completed: false, assigneeId: null, dueDate: null });
  assert.equal(cleared.json.item.completed, false);
  assert.equal(cleared.json.item.assigneeId, null);
  assert.equal(cleared.json.item.dueDate, null);
  assert.equal((await call(ids.dave, 'PATCH', base, { completed: true })).status, 403);
  assert.equal((await call(ids.alice, 'PATCH', `/${list.id}/items/999999`, { completed: true })).status, 404);
  assert.equal((await call(ids.alice, 'DELETE', base)).status, 200);
  assert.equal((await call(ids.alice, 'DELETE', base)).status, 404);
});

test('list routes require authentication', async (t) => {
  if (skipIfNoDb(t)) return;
  const res = await fetch(`${baseUrl}/api/lists`);
  assert.equal(res.status, 401);
});

// ---- typed lists ---------------------------------------------------------------------------------

async function createTable(columns) {
  const res = await call(ids.alice, 'POST', '', { channelId: ids.team, title: 'Tracker', todoMode: false, columns });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}
const colByName = (columns, name) => columns.find((c) => c.name === name);

test('a table list starts with one primary text column plus the requested columns', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list, columns } = await createTable([
    { name: 'Status', type: 'select', options: { choices: [{ label: 'Open', color: 'blue' }, { label: 'Done', color: 'green' }] } },
    { name: 'Estimate', type: 'number', options: { precision: 1 } },
    { name: 'Docs', type: 'link' },
  ]);
  assert.equal(list.todoMode, false);
  assert.deepEqual(columns.map((c) => [c.name, c.type, c.isPrimary]), [['Name', 'text', true], ['Status', 'select', false], ['Estimate', 'number', false], ['Docs', 'link', false]]);
  assert.equal(columns[1].options.choices.length, 2);
  assert.ok(columns[1].options.choices.every((c) => /^c_[0-9a-f]{8}$/.test(c.id)), 'choices get stable ids');
});

test('rows hold typed cells, validated per column, and a bad cell stores nothing', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list, columns } = await createTable([
    { name: 'Status', type: 'select', options: { choices: [{ label: 'Open' }, { label: 'Done' }] } },
    { name: 'Estimate', type: 'number', options: { precision: 1 } },
    { name: 'Owner', type: 'user' },
    { name: 'Due', type: 'date' },
    { name: 'Docs', type: 'link' },
    { name: 'Ready', type: 'checkbox' },
  ]);
  const col = (n) => colByName(columns, n);
  const open = col('Status').options.choices[0].id;
  const base = `/${list.id}/rows`;
  const created = await call(ids.alice, 'POST', base, {
    cells: { title: 'Build login', status: open, estimate: 2.46, owner: ids.bob, due: '2026-04-01', docs: 'https://example.com/spec', ready: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const cells = created.json.row.cells;
  assert.equal(cells[col('Name').id], 'Build login');
  assert.deepEqual(cells[col('Status').id], [open]);
  assert.equal(cells[col('Estimate').id], 2.5, 'rounded to the column precision');
  assert.deepEqual(cells[col('Owner').id], [ids.bob]);
  assert.deepEqual(cells[col('Docs').id], { url: 'https://example.com/spec' });

  const bad = [
    [{ estimate: 'lots' }, /must be a number/],
    [{ status: 'c_nothere' }, /does not exist/],
    [{ owner: ids.dave }, /members of its channel/],
    [{ due: '2026-13-01' }, /valid YYYY-MM-DD/],
    [{ docs: 'javascript:alert(1)' }, /http/],
    [{ nope: 1 }, /Unknown column/],
    [{ title: '' }, /cannot be empty/],
  ];
  for (const [change, pattern] of bad) {
    const res = await call(ids.alice, 'PATCH', `${base}/${created.json.row.id}`, { cells: { ready: false, ...change } });
    assert.equal(res.status, 400, JSON.stringify(change));
    assert.match(res.json.error, pattern);
  }
  const after = (await call(ids.alice, 'GET', `/${list.id}`)).json.rows[0].cells;
  assert.equal(after[col('Ready').id], true, 'a rejected edit applies none of its cells, valid ones included');
});

test('a row needs its primary cell, and several cells change together', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list, columns } = await createTable([{ name: 'Notes', type: 'text' }]);
  assert.equal((await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { notes: 'orphan' } })).status, 400);
  const row = (await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'A' } })).json.row;
  const changed = await call(ids.bob, 'PATCH', `/${list.id}/rows/${row.id}`, { cells: { title: 'B', notes: 'n' } });
  assert.equal(changed.json.row.cells[colByName(columns, 'Name').id], 'B');
  assert.equal(changed.json.row.updatedBy, ids.bob);
  const cleared = await call(ids.bob, 'PATCH', `/${list.id}/rows/${row.id}`, { cells: { notes: null } });
  assert.equal(cleared.json.row.cells[colByName(columns, 'Notes').id], undefined, 'null clears a cell');
  assert.equal((await call(ids.bob, 'PATCH', `/${list.id}/rows/${row.id}`, { cells: {} })).status, 400);
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 1]));
  assert.equal((await call(ids.bob, 'PATCH', `/${list.id}/rows/${row.id}`, { cells: many })).status, 400, 'at most 100 cells per call');
});

test('columns can be added, renamed and removed; the primary one is permanent', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list, columns } = await createTable([]);
  const primary = columns[0];
  const added = await call(ids.alice, 'POST', `/${list.id}/columns`, { name: 'Priority', type: 'select', options: { choices: [{ label: 'High', color: 'red' }, { label: 'Low' }] } });
  assert.equal(added.status, 201);
  const priority = added.json.column;
  assert.equal((await call(ids.alice, 'POST', `/${list.id}/columns`, { name: 'x', type: 'vote' })).status, 400);
  assert.equal((await call(ids.alice, 'PATCH', `/${list.id}/columns/${priority.id}`, { type: 'text' })).status, 400, 'type is fixed');
  const [high, low] = priority.options.choices.map((c) => c.id);
  const row = (await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'Task', priority: [high] } })).json.row;
  await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'Other', priority: [low] } });
  // rename a choice (same id) and drop the other: cells on the renamed one survive, the dropped one clears
  const renamed = await call(ids.alice, 'PATCH', `/${list.id}/columns/${priority.id}`, {
    name: 'Urgency', options: { choices: [{ id: high, label: 'Critical', color: 'red' }] },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.column.name, 'Urgency');
  const rows = (await call(ids.alice, 'GET', `/${list.id}`)).json.rows;
  assert.deepEqual(rows.find((r) => r.id === row.id).cells[priority.id], [high]);
  assert.equal(rows.find((r) => r.id !== row.id).cells[priority.id], undefined, 'removed choice cleared from cells');
  assert.equal((await call(ids.alice, 'DELETE', `/${list.id}/columns/${primary.id}`)).status, 400);
  assert.equal((await call(ids.alice, 'DELETE', `/${list.id}/columns/${priority.id}`)).status, 200);
  const afterDelete = (await call(ids.alice, 'GET', `/${list.id}`)).json;
  assert.ok(!afterDelete.columns.some((c) => c.id === priority.id));
  assert.ok(afterDelete.rows.every((r) => r.cells[priority.id] === undefined), 'its cells went with it');
});

test('guests can read lists but not change them', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list } = await createTable([]);
  const row = (await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'Visible' } })).json.row;
  assert.equal((await call(ids.carol, 'GET', `/${list.id}`)).status, 200);
  assert.equal((await call(ids.carol, 'GET', `?channelId=${ids.team}`)).status, 200);
  assert.equal((await call(ids.carol, 'POST', `/${list.id}/rows`, { cells: { title: 'x' } })).status, 403);
  assert.equal((await call(ids.carol, 'PATCH', `/${list.id}/rows/${row.id}`, { cells: { title: 'x' } })).status, 403);
  assert.equal((await call(ids.carol, 'POST', '', { channelId: ids.team, title: 'guest list' })).status, 403);
  assert.equal((await call(ids.carol, 'DELETE', `/${list.id}`)).status, 403);
  assert.equal((await call(ids.dave, 'GET', `/${list.id}`)).status, 403, 'outsiders see nothing');
});

test('deleting a list removes its columns, rows and cells', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list } = await createTable([{ name: 'Notes', type: 'text' }]);
  await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'A', notes: 'x' } });
  assert.equal((await call(ids.alice, 'DELETE', `/${list.id}`)).status, 200);
  const left = await admin.query(
    `SELECT (SELECT count(*) FROM list_columns WHERE list_id = $1) AS c, (SELECT count(*) FROM list_rows WHERE list_id = $1) AS r`,
    [list.id]
  );
  assert.deepEqual([left.rows[0].c, left.rows[0].r], ['0', '0']);
  assert.equal((await call(ids.alice, 'GET', `/${list.id}`)).status, 404);
});

test('to-do items and table rows are the same thing underneath', async (t) => {
  if (skipIfNoDb(t)) return;
  const list = (await call(ids.alice, 'POST', '', { channelId: ids.team, title: 'Both views' })).json.list;
  const item = (await call(ids.alice, 'POST', `/${list.id}/items`, { title: 'Via old endpoint', assigneeId: ids.bob })).json.item;
  const typed = (await call(ids.alice, 'GET', `/${list.id}`)).json;
  const row = typed.rows.find((r) => r.id === item.id);
  assert.equal(row.cells[colByName(typed.columns, 'Title').id], 'Via old endpoint');
  await call(ids.alice, 'PATCH', `/${list.id}/rows/${item.id}`, { cells: { completed: true } });
  const legacy = (await call(ids.alice, 'GET', `?channelId=${ids.team}`)).json.lists.find((l) => l.id === list.id);
  assert.equal(legacy.items.find((i) => i.id === item.id).completed, true, 'a typed edit shows in the old shape');
});

// ---- subtasks, archive, duplicate, copy, pagination -----------------------------------------------

test('subtasks hang off a row, one level deep', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list } = await createTable([]);
  const parent = (await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'Parent' } })).json.row;
  const child = await call(ids.alice, 'POST', `/${list.id}/rows`, { parentId: parent.id, cells: { title: 'Child' } });
  assert.equal(child.status, 201);
  assert.equal(child.json.row.parentId, parent.id);
  const grandchild = await call(ids.alice, 'POST', `/${list.id}/rows`, { parentId: child.json.row.id, cells: { title: 'Nope' } });
  assert.equal(grandchild.status, 400);
  assert.match(grandchild.json.error, /cannot have subtasks/);
  assert.equal((await call(ids.alice, 'POST', `/${list.id}/rows`, { parentId: 999999, cells: { title: 'x' } })).status, 404);
  // deleting the parent removes its subtasks
  await call(ids.alice, 'DELETE', `/${list.id}/rows/${parent.id}`);
  const rows = (await call(ids.alice, 'GET', `/${list.id}`)).json.rows;
  assert.equal(rows.length, 0);
});

test('archiving hides a row and its subtasks, and restoring brings them back', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list } = await createTable([]);
  const parent = (await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'Parent' } })).json.row;
  await call(ids.alice, 'POST', `/${list.id}/rows`, { parentId: parent.id, cells: { title: 'Child' } });
  await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'Stays' } });
  assert.equal((await call(ids.alice, 'PATCH', `/${list.id}/rows/${parent.id}`, { archived: 'yes' })).status, 400);
  assert.equal((await call(ids.alice, 'PATCH', `/${list.id}/rows/${parent.id}`, { archived: true })).status, 200);
  const active = (await call(ids.alice, 'GET', `/${list.id}`)).json.rows;
  assert.deepEqual(active.map((r) => Object.values(r.cells)[0]), ['Stays']);
  const archived = (await call(ids.alice, 'GET', `/${list.id}?archived=true`)).json.rows;
  assert.equal(archived.length, 2, 'the parent and its subtask');
  await call(ids.alice, 'PATCH', `/${list.id}/rows/${parent.id}`, { archived: false });
  assert.equal((await call(ids.alice, 'GET', `/${list.id}`)).json.rows.length, 3);
  // the old to-do listing leaves archived rows out too
  await call(ids.alice, 'PATCH', `/${list.id}/rows/${parent.id}`, { archived: true });
  const legacy = (await call(ids.alice, 'GET', `?channelId=${ids.team}`)).json.lists.find((l) => l.id === list.id);
  assert.deepEqual(legacy.items.map((i) => i.title), ['Stays']);
});

test('duplicating a row copies its cells, and cells in the request override', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list, columns } = await createTable([{ name: 'Notes', type: 'text' }, { name: 'Done', type: 'checkbox' }]);
  const parent = (await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'Parent' } })).json.row;
  const original = (await call(ids.alice, 'POST', `/${list.id}/rows`, { parentId: parent.id, cells: { title: 'Task', notes: 'keep me', done: true } })).json.row;
  const copy = await call(ids.alice, 'POST', `/${list.id}/rows`, { duplicateOf: original.id, cells: { title: 'Task (copy)' } });
  assert.equal(copy.status, 201);
  assert.notEqual(copy.json.row.id, original.id);
  assert.equal(copy.json.row.parentId, parent.id, 'a duplicated subtask stays under its parent');
  assert.equal(copy.json.row.cells[colByName(columns, 'Name').id], 'Task (copy)');
  assert.equal(copy.json.row.cells[colByName(columns, 'Notes').id], 'keep me');
  assert.equal(copy.json.row.cells[colByName(columns, 'Done').id], true);
  assert.equal((await call(ids.alice, 'POST', `/${list.id}/rows`, { duplicateOf: 424242 })).status, 404);
});

test('copying a list keeps columns, choices and optionally the rows', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list, columns } = await createTable([
    { name: 'Status', type: 'select', options: { choices: [{ label: 'Open' }, { label: 'Done' }] } },
    { name: 'Owner', type: 'user' },
  ]);
  const open = colByName(columns, 'Status').options.choices[0].id;
  const parent = (await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'One', status: open, owner: ids.bob } })).json.row;
  await call(ids.alice, 'POST', `/${list.id}/rows`, { parentId: parent.id, cells: { title: 'Sub' } });
  const archivedRow = (await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: 'Archived' } })).json.row;
  await call(ids.alice, 'PATCH', `/${list.id}/rows/${archivedRow.id}`, { archived: true });

  const withRows = await call(ids.bob, 'POST', `/${list.id}/copy`, { title: 'Tracker 2' });
  assert.equal(withRows.status, 201);
  assert.equal(withRows.json.list.title, 'Tracker 2');
  const copied = (await call(ids.bob, 'GET', `/${withRows.json.list.id}`)).json;
  assert.deepEqual(copied.columns.map((c) => [c.key, c.type, c.isPrimary]), columns.map((c) => [c.key, c.type, c.isPrimary]));
  assert.notEqual(copied.columns[0].id, columns[0].id, 'new columns, not shared ones');
  assert.deepEqual(copied.columns.find((c) => c.key === 'status').options.choices.map((c) => c.id), colByName(columns, 'Status').options.choices.map((c) => c.id), 'choice ids are kept');
  assert.equal(copied.rows.length, 2, 'rows and subtasks come along, archived ones do not');
  const copiedParent = copied.rows.find((r) => r.parentId === null);
  const copiedChild = copied.rows.find((r) => r.parentId !== null);
  assert.equal(copiedChild.parentId, copiedParent.id);
  assert.deepEqual(copiedParent.cells[copied.columns.find((c) => c.key === 'owner').id], [ids.bob]);

  const empty = await call(ids.bob, 'POST', `/${list.id}/copy`, { includeRows: false });
  assert.match(empty.json.list.title, /^Copy of Tracker/);
  assert.equal((await call(ids.bob, 'GET', `/${empty.json.list.id}`)).json.rows.length, 0);

  // into another channel the copy starts without people (they may not be members there)
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ids.other, ids.alice]);
  const across = await call(ids.alice, 'POST', `/${list.id}/copy`, { channelId: ids.other });
  assert.equal(across.status, 201);
  const acrossRows = (await call(ids.alice, 'GET', `/${across.json.list.id}`)).json;
  const ownerColumn = acrossRows.columns.find((c) => c.key === 'owner');
  assert.ok(acrossRows.rows.every((r) => r.cells[ownerColumn.id] === undefined));
  assert.equal((await call(ids.bob, 'POST', `/${list.id}/copy`, { channelId: ids.other })).status, 403, 'you must belong to the target channel');
  assert.equal((await call(ids.carol, 'POST', `/${list.id}/copy`, {})).status, 403, 'guests cannot copy');
  assert.equal((await call(ids.dave, 'POST', `/${list.id}/copy`, {})).status, 403);
});

test('rows are paged with a cursor and nothing is skipped or repeated', async (t) => {
  if (skipIfNoDb(t)) return;
  const { list } = await createTable([]);
  for (let i = 1; i <= 7; i += 1) await call(ids.alice, 'POST', `/${list.id}/rows`, { cells: { title: `Row ${i}` } });
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await call(ids.alice, 'GET', `/${list.id}?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(res.status, 200);
    seen.push(...res.json.rows.map((r) => Object.values(r.cells)[0]));
    cursor = res.json.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, ['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5', 'Row 6', 'Row 7']);
  assert.equal((await call(ids.alice, 'GET', `/${list.id}?limit=0`)).status, 400);
  assert.equal((await call(ids.alice, 'GET', `/${list.id}?limit=3&cursor=garbage`)).status, 400);
  const exact = await call(ids.alice, 'GET', `/${list.id}?limit=7`);
  assert.equal(exact.json.nextCursor, null, 'no next page when the last one is full');
});
