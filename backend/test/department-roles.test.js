// Roles given by department: joining a department gives the role, leaving takes it away, a hand-given role is never taken.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');
const { reconcileUser, reconcileDepartment, reconcileEveryone } = require('../src/departmentRoles');

let scratch; let db;
const ids = {};
const q = (...args) => db.query(...args);

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  db = await scratch.open();
  await scratch.applyInit(db);
  await scratch.applyMigrations(db);
  const user = async (name) => (await q("INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING id", [name, `${name}@x.test`])).rows[0].id;
  ids.u1 = await user('dr-one'); ids.u2 = await user('dr-two'); ids.u3 = await user('dr-three');
  const dept = async (name) => (await q('INSERT INTO departments (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  ids.mis = await dept('dr-MIS'); ids.fin = await dept('dr-Finance');
  const role = async (name) => (await q('INSERT INTO roles (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  ids.tools = await role('dr-MIS tools'); ids.books = await role('dr-Books');
  ids.owner = (await q("SELECT id FROM roles WHERE builtin_key = 'owner'")).rows[0].id;
});

test.after(async () => {
  if (db) await db.end();
  if (scratch) await scratch.drop();
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const join = (user, department) => q('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, false) ON CONFLICT DO NOTHING', [user, department]);
const leave = (user, department) => q('DELETE FROM user_departments WHERE user_id = $1 AND department_id = $2', [user, department]);
const rule = (department, role) => q('INSERT INTO department_roles (department_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [department, role]);
const held = async (user) => (await q('SELECT role_id, auto, assigned_by FROM user_roles WHERE user_id = $1 ORDER BY role_id', [user])).rows;

test('the rule table exists, rows are not automatic unless a rule made them, and the migrations can run again', async (t) => {
  if (skip(t)) return;
  const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'department_roles' ORDER BY column_name")).rows.map((r) => r.column_name);
  assert.deepEqual(cols, ['department_id', 'role_id']);
  await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.u3, ids.books]);
  assert.equal((await held(ids.u3))[0].auto, false);
  await q('DELETE FROM user_roles WHERE user_id = $1', [ids.u3]);
  await scratch.applyMigrations(db);
  await scratch.applyMigrations(db);
});

test('joining a department with a rule gives the role, marked automatic, and doing it again changes nothing', async (t) => {
  if (skip(t)) return;
  await rule(ids.mis, ids.tools);
  await join(ids.u1, ids.mis);
  assert.deepEqual(await reconcileUser(q, ids.u1), { added: [ids.tools], removed: [] });
  assert.deepEqual(await held(ids.u1), [{ role_id: ids.tools, auto: true, assigned_by: null }]);
  assert.deepEqual(await reconcileUser(q, ids.u1), { added: [], removed: [] });
});

test('leaving the department takes the automatic role away', async (t) => {
  if (skip(t)) return;
  await leave(ids.u1, ids.mis);
  assert.deepEqual(await reconcileUser(q, ids.u1), { added: [], removed: [ids.tools] });
  assert.deepEqual(await held(ids.u1), []);
});

test('a role given by hand stays after leaving, and the rule does not claim it', async (t) => {
  if (skip(t)) return;
  await q('INSERT INTO user_roles (user_id, role_id, assigned_by, auto) VALUES ($1, $2, $1, false)', [ids.u2, ids.tools]);
  await join(ids.u2, ids.mis);
  assert.deepEqual(await reconcileUser(q, ids.u2), { added: [], removed: [] });
  assert.equal((await held(ids.u2))[0].auto, false);
  await leave(ids.u2, ids.mis);
  assert.deepEqual(await reconcileUser(q, ids.u2), { added: [], removed: [] });
  assert.equal((await held(ids.u2)).length, 1);
  await q('DELETE FROM user_roles WHERE user_id = $1', [ids.u2]);
});

test('with two departments giving the same role it stays until the person has left both', async (t) => {
  if (skip(t)) return;
  await rule(ids.fin, ids.tools);
  await join(ids.u1, ids.mis); await join(ids.u1, ids.fin);
  await reconcileUser(q, ids.u1);
  await leave(ids.u1, ids.mis);
  assert.deepEqual(await reconcileUser(q, ids.u1), { added: [], removed: [] });
  assert.equal((await held(ids.u1)).length, 1);
  await leave(ids.u1, ids.fin);
  assert.deepEqual(await reconcileUser(q, ids.u1), { added: [], removed: [ids.tools] });
  await q('DELETE FROM department_roles WHERE department_id = $1', [ids.fin]);
});

test('a built-in role is never given by a rule, even if a rule row for it exists', async (t) => {
  if (skip(t)) return;
  await q('INSERT INTO department_roles (department_id, role_id) VALUES ($1, $2)', [ids.mis, ids.owner]);
  await join(ids.u1, ids.mis);
  const result = await reconcileUser(q, ids.u1);
  assert.deepEqual(result.added, [ids.tools]);
  assert.ok(!(await held(ids.u1)).some((row) => row.role_id === ids.owner));
  await q('DELETE FROM department_roles WHERE role_id = $1', [ids.owner]);
  await leave(ids.u1, ids.mis); await reconcileUser(q, ids.u1);
});

test('changing a rule brings the whole department in line, and removing it takes the role back', async (t) => {
  if (skip(t)) return;
  await join(ids.u1, ids.mis); await join(ids.u3, ids.mis);
  await rule(ids.mis, ids.books);
  const added = await reconcileDepartment(q, ids.mis);
  assert.deepEqual(added.map((row) => row.userId).sort(), [ids.u1, ids.u3].sort());
  assert.ok(added.every((row) => row.added.includes(ids.books)));
  await q('DELETE FROM department_roles WHERE department_id = $1 AND role_id = $2', [ids.mis, ids.books]);
  const removed = await reconcileDepartment(q, ids.mis);
  assert.ok(removed.every((row) => row.removed.includes(ids.books)) && removed.length === 2);
  assert.ok(!(await held(ids.u1)).some((row) => row.role_id === ids.books));
});

test('deleting a department and checking everyone removes the roles it gave', async (t) => {
  if (skip(t)) return;
  assert.ok((await held(ids.u1)).some((row) => row.role_id === ids.tools));
  await q('DELETE FROM departments WHERE id = $1', [ids.mis]);
  const changes = await reconcileEveryone(q);
  assert.ok(changes.some((row) => row.userId === ids.u1 && row.removed.includes(ids.tools)));
  assert.deepEqual(await held(ids.u1), []);
  assert.deepEqual(await reconcileEveryone(q), []);
});

test('a rule that gives the former HR role keeps the person\'s HR flag in step', async (t) => {
  if (skip(t)) return;
  const hr = (await q('SELECT id FROM roles WHERE legacy_hr = true LIMIT 1')).rows[0];
  if (!hr) return t.skip('no former HR role in this database');
  const dept = (await q("INSERT INTO departments (name) VALUES ('dr-People') RETURNING id")).rows[0].id;
  await rule(dept, hr.id);
  await join(ids.u3, dept);
  await reconcileUser(q, ids.u3);
  assert.equal((await q('SELECT is_hr FROM users WHERE id = $1', [ids.u3])).rows[0].is_hr, true);
  await leave(ids.u3, dept);
  await reconcileUser(q, ids.u3);
  assert.equal((await q('SELECT is_hr FROM users WHERE id = $1', [ids.u3])).rows[0].is_hr, false);
});
