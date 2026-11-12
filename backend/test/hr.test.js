// Employee management: records, departments, the HR role and the export, against a real PostgreSQL (scratch database).
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
  process.env.JWT_SECRET = 'hr-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, { type = 'member', superadmin = false, hr = false } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin, is_hr) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [name, `${name}@x.test`, 'x', type, superadmin, hr]
  )).rows[0].id;
  ids.boss = await user('boss', { superadmin: true });
  ids.hr = await user('hana', { hr: true });
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  ids.guest = await user('visitor', { type: 'guest' });
  const app = express();
  app.use(express.json());
  app.use('/api/hr', require('../src/routes/hr'));
  app.use('/api/people', require('../src/routes/people'));
  app.use('/api/admin', require('../src/routes/admin'));
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

const call = async (userId, method, path, body) => {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

test('only the Superadmin and HR reach employee records; everyone else is refused', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'GET', '/hr/employees')).status, 403);
  assert.equal((await call(ids.guest, 'GET', '/hr/employees')).status, 403);
  assert.equal((await call(ids.ann, 'PUT', `/hr/employees/${ids.bob}`, { employeeNo: 'X' })).status, 403);
  const list = await call(ids.hr, 'GET', '/hr/employees');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.employees.map((e) => e.username).sort(), ['ann', 'bob', 'boss', 'hana'], 'members only');
  assert.deepEqual((await call(ids.hr, 'GET', '/hr/me')).json, { canManage: true, isHr: true, isSuperadmin: false });
  assert.equal((await call(ids.ann, 'GET', '/hr/me')).json.canManage, false);
});

test('a record is edited field by field, and bad values are refused', async (t) => {
  if (skip(t)) return;
  const dept = (await call(ids.hr, 'POST', '/hr/departments', { name: 'Finance' })).json.department;
  const saved = await call(ids.hr, 'PUT', `/hr/employees/${ids.ann}`, {
    employeeNo: 'E-0001', hireDate: '2024-03-15', employmentType: 'regular', departmentId: dept.id, jobTitle: 'Accountant', lastName: 'Lee', firstName: 'Ann',
  });
  assert.equal(saved.status, 200);
  const e = saved.json.employee;
  assert.deepEqual([e.employeeNo, e.hireDate, e.employmentType, e.department, e.jobTitle, e.employmentStatus], ['E-0001', '2024-03-15', 'regular', 'Finance', 'Accountant', 'active']);
  const put = (body) => call(ids.hr, 'PUT', `/hr/employees/${ids.ann}`, body);
  assert.equal((await put({ employmentStatus: 'on_leave' })).json.employee.employmentStatus, 'on_leave');
  assert.equal((await put({ employmentStatus: 'on_leave' })).json.employee.employeeNo, 'E-0001', 'other fields are kept');
  assert.equal((await put({ employmentStatus: 'fired' })).status, 400);
  assert.equal((await put({ employmentType: 'slave' })).status, 400);
  assert.equal((await put({ hireDate: '2024-02-30' })).status, 400, 'not a real date');
  assert.equal((await put({ hireDate: '15/03/2024' })).status, 400);
  assert.equal((await put({ departmentId: 99999 })).status, 404);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ jobTitle: 'x'.repeat(101) })).status, 400);
  assert.equal((await call(ids.hr, 'PUT', `/hr/employees/${ids.bob}`, { employeeNo: 'e-0001' })).status, 409, 'employee numbers are unique, ignoring case');
  assert.equal((await put({ employeeNo: '', hireDate: null })).json.employee.hireDate, null, 'a value can be cleared');
  assert.equal((await call(ids.hr, 'PUT', `/hr/employees/${ids.guest}`, { jobTitle: 'x' })).status, 404, 'guests have no employee record');
  const peoplePage = (await call(ids.bob, 'GET', `/people/${ids.ann}`)).json.person;
  assert.equal(peoplePage.department, 'Finance', 'the People pages show the department');
});

test('departments: create, rename (people follow), set a head, delete (people keep working)', async (t) => {
  if (skip(t)) return;
  const made = await call(ids.hr, 'POST', '/hr/departments', { name: 'Operations', headId: ids.bob });
  assert.equal(made.status, 201);
  assert.equal(made.json.department.headUsername, 'bob');
  assert.equal((await call(ids.hr, 'POST', '/hr/departments', { name: 'operations' })).status, 409, 'names are unique, ignoring case');
  assert.equal((await call(ids.hr, 'POST', '/hr/departments', { name: '  ' })).status, 400);
  assert.equal((await call(ids.hr, 'POST', '/hr/departments', { name: 'X', headId: ids.guest })).status, 404, 'a head must be a member');
  assert.equal((await call(ids.ann, 'POST', '/hr/departments', { name: 'Nope' })).status, 403);
  const id = made.json.department.id;
  await call(ids.hr, 'PUT', `/hr/employees/${ids.bob}`, { departmentId: id });
  const renamed = await call(ids.hr, 'PUT', `/hr/departments/${id}`, { name: 'Operations & Logistics' });
  assert.equal(renamed.json.department.memberCount, 1);
  assert.equal(renamed.json.department.headId, ids.bob, 'renaming keeps the head');
  assert.equal((await call(ids.bob, 'GET', `/people/${ids.bob}`)).json.person.department, 'Operations & Logistics');
  assert.equal((await call(ids.hr, 'PUT', `/hr/departments/${id}`, { headId: null })).json.department.headId, null);
  const list = await call(ids.bob, 'GET', '/hr/departments');
  assert.equal(list.status, 200, 'every member can read the list');
  assert.equal((await call(ids.guest, 'GET', '/hr/departments')).status, 403);
  assert.equal((await call(ids.hr, 'DELETE', `/hr/departments/${id}`)).status, 200);
  const bob = (await call(ids.hr, 'GET', '/hr/employees')).json.employees.find((e) => e.username === 'bob');
  assert.deepEqual([bob.departmentId, bob.department], [null, '']);
  assert.equal((await call(ids.hr, 'DELETE', `/hr/departments/${id}`)).status, 404);
});

test('only the Superadmin gives out the HR role', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.hr, 'PUT', `/hr/employees/${ids.ann}/hr-role`, { isHr: true })).status, 403, 'HR cannot make more HR');
  assert.equal((await call(ids.boss, 'PUT', `/hr/employees/${ids.ann}/hr-role`, { isHr: 'yes' })).status, 400);
  assert.equal((await call(ids.boss, 'PUT', `/hr/employees/${ids.ann}/hr-role`, { isHr: true })).status, 200);
  assert.equal((await call(ids.ann, 'GET', '/hr/me')).json.canManage, true);
  assert.equal((await call(ids.boss, 'PUT', `/hr/employees/${ids.ann}/hr-role`, { isHr: false })).status, 200);
  assert.equal((await call(ids.ann, 'GET', '/hr/me')).json.canManage, false);
});

test('HR sets reporting lines and names, and creates member accounts but not guests', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.hr, 'PUT', `/people/${ids.bob}/manager`, { managerId: ids.ann })).status, 200);
  assert.equal((await call(ids.hr, 'PUT', `/people/${ids.bob}/secondary-managers`, { managerIds: [ids.boss] })).status, 200);
  assert.equal((await call(ids.hr, 'PUT', `/people/${ids.bob}/names`, { lastName: 'Cruz' })).status, 200);
  assert.equal((await call(ids.bob, 'PUT', `/people/${ids.ann}/manager`, { managerId: null })).status, 403, 'an ordinary member cannot');
  assert.equal((await call(ids.hr, 'GET', `/people/${ids.bob}`)).json.canSetManager, true);
  const made = await call(ids.hr, 'POST', '/admin/users', { accounts: [{ username: 'newhire', email: 'newhire@x.test' }] });
  assert.equal(made.status, 201);
  assert.equal((await call(ids.hr, 'POST', '/admin/users', { accounts: [{ username: 'g1', email: 'g1@x.test' }], accountType: 'guest', channelIds: [1] })).status, 403);
  assert.equal((await call(ids.ann, 'POST', '/admin/users', { accounts: [{ username: 'g2', email: 'g2@x.test' }] })).status, 403);
});

test('the export is a CSV with names, department and manager, and formulas are defused', async (t) => {
  if (skip(t)) return;
  await call(ids.hr, 'PUT', `/hr/employees/${ids.ann}`, { employeeNo: 'A-1', jobTitle: '=SUM(1+1)', lastName: 'Lee', firstName: 'Ann' });
  assert.equal((await call(ids.ann, 'GET', '/hr/export')).status, 403);
  await admin.query("UPDATE users SET profile = jsonb_build_object('phone', '+63 922 766 7968') WHERE id = $1", [ids.ann]);
  const out = await call(ids.hr, 'GET', '/hr/export');
  assert.equal(out.status, 200);
  const lines = out.json.csv.split('\r\n');
  assert.equal(lines[0], 'Employee no.,Last name,First name,Middle name,Username,Email,Job title,Department,Employment type,Status,Hire date,Last day,Location,Phone,Reports to');
  const ann = lines.find((l) => l.includes('ann@x.test'));
  assert.match(ann, /^A-1,Lee,Ann,,ann,ann@x\.test,'=SUM\(1\+1\),/);
  assert.match(ann, /,\+63 922 766 7968,/, 'a phone number keeps its plus');
  assert.equal(out.json.count, lines.filter(Boolean).length - 1);
});

test('departments typed on employee pages before this feature become real departments', async (t) => {
  if (skip(t)) return;
  await admin.query("UPDATE users SET department = 'Legacy Dept', department_id = NULL WHERE id = $1", [ids.bob]);
  const migrations = require('../src/migrations');
  for (const statement of migrations) await admin.query(statement);
  const list = (await call(ids.hr, 'GET', '/hr/departments')).json.departments;
  const legacy = list.find((d) => d.name === 'Legacy Dept');
  assert.ok(legacy, 'the department was created');
  assert.equal(legacy.memberCount, 1);
});
