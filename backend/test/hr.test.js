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
  app.use('/api/auth', require('../src/routes/auth'));
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

const call = async (userId, method, path, body, tokenVersion = 0) => {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
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

const makeMember = async (name) => (await admin.query(
  'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [name, `${name}@x.test`, require('bcryptjs').hashSync('Old-pass-123', 4)]
)).rows[0].id;

test('deactivating: signed out now, cannot sign in, hidden, reports move up, checklist starts; reactivating brings them back', async (t) => {
  if (skip(t)) return;
  const lead = await makeMember('lead');
  const leaver = await makeMember('leaver');
  const report = await makeMember('report');
  await admin.query('UPDATE users SET manager_id = $1 WHERE id = $2', [lead, leaver]);
  await admin.query('UPDATE users SET manager_id = $1 WHERE id = $2', [leaver, report]);
  const dept = (await call(ids.hr, 'POST', '/hr/departments', { name: 'Leavers', headId: leaver })).json.department;

  assert.equal((await call(ids.ann, 'POST', `/hr/employees/${leaver}/deactivate`, {})).status, 403);
  assert.equal((await call(ids.hr, 'POST', `/hr/employees/${ids.hr}/deactivate`, {})).status, 400, 'not yourself');
  assert.equal((await call(ids.hr, 'POST', `/hr/employees/${ids.boss}/deactivate`, {})).status, 400, 'not a Superadmin');
  assert.equal((await call(ids.hr, 'POST', `/hr/employees/${leaver}/deactivate`, { lastDay: 'soon' })).status, 400);
  const done = await call(ids.hr, 'POST', `/hr/employees/${leaver}/deactivate`, { lastDay: '2026-12-31' });
  assert.equal(done.status, 200);
  assert.equal(done.json.reassignedReports, 1);
  assert.equal(done.json.employee.employmentStatus, 'resigned');
  assert.equal(done.json.employee.separationDate, '2026-12-31');
  assert.ok(done.json.employee.deactivatedAt);
  assert.equal(done.json.employee.checklists.offboarding.total, 4, 'the standard offboarding checklist started');
  assert.equal((await call(ids.hr, 'POST', `/hr/employees/${leaver}/deactivate`, {})).status, 400, 'already deactivated');

  assert.equal((await call(leaver, 'GET', '/people')).status, 403, 'their old session is gone');
  const login = await call(0, 'POST', '/auth/login', { username: 'leaver', password: 'Old-pass-123' });
  assert.equal(login.status, 403);
  assert.match(login.json.error, /deactivated/);
  const people = (await call(ids.ann, 'GET', '/people')).json.people;
  assert.ok(!people.some((p) => p.username === 'leaver'), 'gone from the directory and the chart');
  assert.equal(people.find((p) => p.username === 'report').managerId, lead, 'their report now reports to the leaver manager');
  const dpt = (await call(ids.hr, 'GET', '/hr/departments')).json.departments.find((d) => d.id === dept.id);
  assert.equal(dpt.headId, null, 'no longer a department head');
  assert.ok((await call(ids.hr, 'GET', '/hr/employees')).json.employees.some((e) => e.username === 'leaver'), 'HR still sees the record');

  assert.equal((await call(ids.hr, 'POST', `/hr/employees/${leaver}/reactivate`, {})).json.employee.employmentStatus, 'active');
  assert.equal((await call(ids.hr, 'POST', `/hr/employees/${leaver}/reactivate`, {})).status, 400);
  assert.equal((await call(0, 'POST', '/auth/login', { username: 'leaver', password: 'Old-pass-123' })).status, 200);
});

test('resetting a password gives a temporary one, once, and signs the person out', async (t) => {
  if (skip(t)) return;
  const who = await makeMember('forgetful');
  assert.equal((await call(ids.ann, 'POST', `/hr/employees/${who}/reset-password`, {})).status, 403);
  assert.equal((await call(ids.hr, 'POST', `/hr/employees/${ids.boss}/reset-password`, {})).status, 403, 'HR cannot reset a Superadmin');
  const reset = await call(ids.hr, 'POST', `/hr/employees/${who}/reset-password`, {});
  assert.equal(reset.status, 200);
  assert.match(reset.json.password, /^[A-Za-z2-9]{12}$/);
  assert.equal((await call(who, 'GET', '/hr/me')).status, 403, 'old session signed out');
  assert.equal((await call(0, 'POST', '/auth/login', { username: 'forgetful', password: 'Old-pass-123' })).status, 401);
  const login = await call(0, 'POST', '/auth/login', { username: 'forgetful', password: reset.json.password });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.mustChangePassword, true);
});

test('checklists: new accounts start onboarding, tasks can be ticked, added and removed, and HR edits the standard lists', async (t) => {
  if (skip(t)) return;
  const made = await call(ids.hr, 'POST', '/admin/users', { accounts: [{ username: 'fresh', email: 'fresh@x.test' }] });
  const fresh = made.json.created[0].id;
  const list = (await call(ids.hr, 'GET', `/hr/employees/${fresh}/tasks`)).json.tasks;
  assert.equal(list.filter((x) => x.kind === 'onboarding').length, 4, 'the standard onboarding list');
  assert.equal(list.filter((x) => x.kind === 'offboarding').length, 0);

  const ticked = await call(ids.hr, 'PUT', `/hr/tasks/${list[0].id}`, { done: true });
  assert.equal(ticked.json.task.done, true);
  assert.equal(ticked.json.task.doneBy, 'hana');
  const row = (await call(ids.hr, 'GET', '/hr/employees')).json.employees.find((e) => e.id === fresh);
  assert.deepEqual(row.checklists.onboarding, { done: 1, total: 4 });
  assert.equal((await call(ids.hr, 'PUT', `/hr/tasks/${list[0].id}`, { done: false })).json.task.done, false);
  assert.equal((await call(ids.hr, 'PUT', `/hr/tasks/${list[0].id}`, { done: 'yes' })).status, 400);
  assert.equal((await call(ids.ann, 'PUT', `/hr/tasks/${list[0].id}`, { done: true })).status, 403);

  const added = await call(ids.hr, 'POST', `/hr/employees/${fresh}/tasks`, { kind: 'onboarding', title: 'Set up the badge' });
  assert.equal(added.status, 201);
  assert.equal(added.json.tasks.at(-1).title, 'Set up the badge');
  assert.equal((await call(ids.hr, 'POST', `/hr/employees/${fresh}/tasks`, { kind: 'other', title: 'x' })).status, 400);
  assert.equal((await call(ids.hr, 'POST', `/hr/employees/${fresh}/tasks`, { kind: 'onboarding', title: ' ' })).status, 400);
  assert.equal((await call(ids.hr, 'DELETE', `/hr/tasks/${added.json.tasks.at(-1).id}`)).status, 200);
  assert.equal((await call(ids.hr, 'DELETE', `/hr/tasks/${added.json.tasks.at(-1).id}`)).status, 404);
  const started = await call(ids.hr, 'POST', `/hr/employees/${fresh}/tasks`, { kind: 'offboarding', apply: true });
  assert.equal(started.json.tasks.filter((x) => x.kind === 'offboarding').length, 4, 'start the standard offboarding list by hand');

  const saved = await call(ids.hr, 'PUT', '/hr/task-templates', { kind: 'onboarding', titles: ['Badge', 'Laptop', ' '] });
  assert.deepEqual(saved.json.titles, ['Badge', 'Laptop']);
  assert.deepEqual((await call(ids.hr, 'GET', '/hr/task-templates')).json.onboarding, ['Badge', 'Laptop']);
  assert.equal((await call(ids.hr, 'GET', '/hr/task-templates')).json.offboarding.length, 4, 'the other list is untouched');
  assert.equal((await call(ids.hr, 'PUT', '/hr/task-templates', { kind: 'nope', titles: [] })).status, 400);
  assert.equal((await call(ids.hr, 'GET', `/hr/employees/${fresh}/tasks`)).json.tasks.filter((x) => x.kind === 'onboarding').length, 4, 'people keep the list they have');
});

test('only the Superadmin changes a username; it must be free, and the change is logged', async (t) => {
  if (skip(t)) return;
  const who = await makeMember('oldname');
  assert.equal((await call(ids.hr, 'PUT', `/hr/employees/${who}`, { username: 'newname' })).status, 403, 'HR cannot');
  assert.equal((await call(ids.boss, 'PUT', `/hr/employees/${who}`, { username: 'ann' })).status, 409, 'already taken');
  assert.equal((await call(ids.boss, 'PUT', `/hr/employees/${who}`, { username: 'ANN' })).status, 409);
  assert.equal((await call(ids.boss, 'PUT', `/hr/employees/${who}`, { username: 'has space' })).status, 400);
  assert.equal((await call(ids.boss, 'PUT', `/hr/employees/${who}`, { username: '' })).status, 400);
  assert.equal((await call(ids.boss, 'PUT', `/hr/employees/${who}`, { username: 'x'.repeat(51) })).status, 400);
  const done = await call(ids.boss, 'PUT', `/hr/employees/${who}`, { username: 'newname' });
  assert.equal(done.status, 200);
  assert.equal(done.json.employee.username, 'newname');
  assert.equal((await call(0, 'POST', '/auth/login', { username: 'newname', password: 'Old-pass-123' })).status, 200, 'they sign in with the new name');
  assert.equal((await call(0, 'POST', '/auth/login', { username: 'oldname', password: 'Old-pass-123' })).status, 401);
  const log = (await admin.query("SELECT details FROM moderation_audit_log WHERE action = 'username_changed' AND target_user_id = $1", [who])).rows;
  assert.deepEqual(log.map((r) => r.details), [{ from: 'oldname', to: 'newname' }]);
  assert.equal((await call(ids.boss, 'PUT', `/hr/employees/${who}`, { username: 'newname' })).status, 200, 'saving the same name again is fine');
});

test('HR and the Superadmin correct an email address: valid, unique, and logged', async (t) => {
  if (skip(t)) return;
  const who = await makeMember('emailer');
  assert.equal((await call(ids.ann, 'PUT', `/hr/employees/${who}`, { email: 'new@x.test' })).status, 403, 'an employee cannot change someone else\'s');
  assert.equal((await call(ids.hr, 'PUT', `/hr/employees/${who}`, { email: 'not-an-email' })).status, 400);
  assert.equal((await call(ids.hr, 'PUT', `/hr/employees/${who}`, { email: 'ann@x.test' })).status, 409, 'already used by ann');
  assert.equal((await call(ids.hr, 'PUT', `/hr/employees/${who}`, { email: 'ANN@X.TEST' })).status, 409, 'ignoring case');
  const done = await call(ids.hr, 'PUT', `/hr/employees/${who}`, { email: ' New.Address@X.test ' });
  assert.equal(done.status, 200);
  assert.equal(done.json.employee.email, 'new.address@x.test', 'trimmed and lower-cased');
  assert.equal((await call(ids.hr, 'PUT', `/hr/employees/${who}`, { email: 'new.address@x.test' })).status, 200, 'saving the same address again is fine');
  const log = (await admin.query("SELECT details FROM moderation_audit_log WHERE action = 'email_changed' AND target_user_id = $1", [who])).rows;
  assert.deepEqual(log.map((r) => r.details), [{ from: 'emailer@x.test', to: 'new.address@x.test' }], 'one entry, for the real change');
});
