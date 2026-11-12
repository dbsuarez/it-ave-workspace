// Attendance: clocking, timesheets, the board, schedules and the payroll-ready export, against a real PostgreSQL (scratch database).
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

const DAY = 24 * 60 * 60 * 1000;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
// A Monday in the past (last week's), so every day of that week is over whatever today is
function pastMonday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return addDays(d, -(((d.getUTCDay() + 6) % 7) + 7));
}

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'attendance-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, { hr = false, manager = null, hire = null } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_hr, manager_id, hire_date, last_name, first_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [name, `${name}@x.test`, 'x', hr, manager, hire, name.toUpperCase(), 'F']
  )).rows[0].id;
  ids.hr = await user('hana', { hr: true });
  ids.lead = await user('lead');
  ids.ann = await user('ann', { manager: ids.lead });
  ids.bob = await user('bob', { manager: ids.lead });
  ids.cy = await user('cy');
  ids.guest = (await admin.query("INSERT INTO users (username, email, password_hash, account_type) VALUES ('visitor', 'v@x.test', 'x', 'guest') RETURNING id")).rows[0].id;
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', require('../src/routes/attendance'));
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
  const res = await fetch(`${baseUrl}/api/attendance${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const mondayText = () => iso(pastMonday());

test('clocking in and out: once a day, in the company time zone, only for active members', async (t) => {
  if (skip(t)) return;
  const first = await call(ids.cy, 'GET', '/today');
  assert.equal(first.status, 200);
  assert.equal(first.json.timezone, 'Asia/Manila');
  assert.equal(first.json.schedule.start, '09:00');
  assert.equal(first.json.record, null);
  const expectedToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  assert.equal(first.json.today, expectedToday, 'today is the company\'s date');

  assert.equal((await call(ids.cy, 'POST', '/clock-out')).status, 400, 'not clocked in yet');
  const inn = await call(ids.cy, 'POST', '/clock-in');
  assert.equal(inn.status, 201);
  assert.equal(inn.json.record.open, true);
  assert.match(inn.json.record.clockIn, /^\d\d:\d\d$/);
  assert.equal((await call(ids.cy, 'POST', '/clock-in')).status, 409, 'once a day');
  const out = await call(ids.cy, 'POST', '/clock-out');
  assert.equal(out.status, 200);
  assert.equal(out.json.record.open, false);
  assert.equal((await call(ids.cy, 'POST', '/clock-out')).status, 400, 'already out');
  assert.equal((await call(ids.guest, 'POST', '/clock-in')).status, 403);
});

test('HR fixes a day; late, undertime and overtime follow the schedule', async (t) => {
  if (skip(t)) return;
  const mon = mondayText();
  assert.equal((await call(ids.ann, 'PUT', '/records', { userId: ids.ann, date: mon, clockIn: '09:00', clockOut: '18:00' })).status, 403, 'not even for yourself');
  const late = await call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: mon, clockIn: '09:30', clockOut: '18:45', note: 'Forgot to clock out' });
  assert.equal(late.status, 200);
  assert.deepEqual([late.json.day.status, late.json.day.lateMinutes, late.json.day.overtimeMinutes, late.json.day.source], ['present', 30, 45, 'hr']);
  assert.equal(late.json.day.workedMinutes, 9 * 60 + 15 - 60);
  const tue = iso(addDays(pastMonday(), 1));
  const early = await call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: tue, clockIn: '08:50', clockOut: '17:00' });
  assert.equal(early.json.day.undertimeMinutes, 60);
  assert.equal((await call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: tue, clockIn: '9:00' })).status, 400, 'times look like 09:00');
  assert.equal((await call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: '2026-02-30', clockIn: '09:00' })).status, 400);
  const open = await call(ids.hr, 'PUT', '/records', { userId: ids.bob, date: mon, clockIn: '09:00' });
  assert.equal(open.json.day.status, 'incomplete', 'a past day with no clock-out');
  const night = await call(ids.hr, 'PUT', '/records', { userId: ids.cy, date: mon, clockIn: '22:00', clockOut: '06:00' });
  assert.equal(night.json.day.workedMinutes, 8 * 60 - 60, 'a clock-out before the clock-in is the next morning');
});

test('absent, on leave and holiday days; the timesheet adds it all up', async (t) => {
  if (skip(t)) return;
  const mon = pastMonday();
  const wed = iso(addDays(mon, 2));
  const thu = iso(addDays(mon, 3));
  await admin.query("INSERT INTO company_holidays (day, name) VALUES ($1, 'Test Holiday') ON CONFLICT DO NOTHING", [thu]);
  const vacation = (await admin.query("SELECT id FROM leave_types WHERE name = 'Vacation Leave'")).rows[0].id;
  const unpaid = (await admin.query("SELECT id FROM leave_types WHERE name = 'Unpaid Leave'")).rows[0].id;
  await admin.query("INSERT INTO leave_requests (user_id, leave_type_id, start_date, end_date, days, status) VALUES ($1, $2, $3, $3, 1, 'approved')", [ids.ann, vacation, wed]);
  await admin.query("INSERT INTO leave_requests (user_id, leave_type_id, start_date, end_date, days, status) VALUES ($1, $2, $3, $3, 1, 'approved')", [ids.ann, unpaid, iso(addDays(mon, 4))]);

  const sheet = await call(ids.ann, 'GET', `/timesheet?from=${iso(mon)}&to=${iso(addDays(mon, 6))}`);
  assert.equal(sheet.status, 200);
  const by = Object.fromEntries(sheet.json.days.map((d) => [d.date, d.status]));
  assert.deepEqual([by[iso(mon)], by[iso(addDays(mon, 1))], by[wed], by[thu], by[iso(addDays(mon, 4))], by[iso(addDays(mon, 5))]], ['present', 'present', 'leave', 'holiday', 'leave', 'rest']);
  const t1 = sheet.json.totals;
  assert.deepEqual([t1.scheduledDays, t1.presentDays, t1.absentDays, t1.paidLeaveDays, t1.unpaidLeaveDays, t1.holidays, t1.lateMinutes], [4, 2, 0, 1, 1, 1, 30]);

  const bobSheet = (await call(ids.bob, 'GET', `/timesheet?from=${iso(mon)}&to=${iso(addDays(mon, 4))}`)).json;
  assert.equal(bobSheet.totals.absentDays, 3, 'Tue, Wed, Fri: no record, no leave (Thursday is a holiday, Monday has an open record)');
  assert.equal(bobSheet.totals.incompleteDays, 1);
});

test('who may see a timesheet: yourself, your manager, HR', async (t) => {
  if (skip(t)) return;
  const q = `from=${mondayText()}&to=${iso(addDays(pastMonday(), 4))}`;
  assert.equal((await call(ids.bob, 'GET', `/timesheet?userId=${ids.ann}&${q}`)).status, 403, 'a colleague cannot');
  assert.equal((await call(ids.lead, 'GET', `/timesheet?userId=${ids.ann}&${q}`)).status, 200, 'the manager can');
  assert.equal((await call(ids.hr, 'GET', `/timesheet?userId=${ids.ann}&${q}`)).status, 200);
  assert.equal((await call(ids.ann, 'GET', `/timesheet?${q}`)).status, 200);
  assert.equal((await call(ids.ann, 'GET', '/timesheet?from=2026-01-01&to=2026-12-31')).status, 400, 'at most 62 days');
  assert.equal((await call(ids.ann, 'GET', '/timesheet?month=2026-13')).status, 400);
  assert.equal((await call(ids.ann, 'GET', '/timesheet')).status, 200, 'defaults to this month');
});

test('the board: HR sees everyone, a manager sees their team, others see nobody', async (t) => {
  if (skip(t)) return;
  const date = mondayText();
  const all = (await call(ids.hr, 'GET', `/board?date=${date}`)).json;
  assert.equal(all.scope, 'all');
  assert.ok(all.rows.length >= 5);
  const ann = all.rows.find((r) => r.username === 'ann');
  assert.deepEqual([ann.status, ann.clockIn, ann.clockOut, ann.lateMinutes], ['present', '09:30', '18:45', 30]);
  const team = (await call(ids.lead, 'GET', `/board?date=${date}`)).json;
  assert.deepEqual(team.rows.map((r) => r.username).sort(), ['ann', 'bob']);
  assert.equal(team.scope, 'team');
  assert.equal((await call(ids.cy, 'GET', `/board?date=${date}`)).json.rows.length, 0);
  assert.equal((await call(ids.hr, 'GET', '/board?date=nope')).status, 400);
});

test('schedules: HR creates, assigns, changes the default; the default stays', async (t) => {
  if (skip(t)) return;
  const list = (await call(ids.ann, 'GET', '/schedules')).json.schedules;
  assert.equal(list.length, 1);
  assert.equal(list[0].isDefault, true);
  const body = { name: 'Night shift', start: '22:00', end: '06:00', breakMinutes: 60, graceMinutes: 5, overtimeMinMinutes: 30, workDays: [1, 2, 3, 4, 5] };
  assert.equal((await call(ids.ann, 'POST', '/schedules', body)).status, 403);
  const made = await call(ids.hr, 'POST', '/schedules', body);
  assert.equal(made.status, 201);
  assert.equal((await call(ids.hr, 'POST', '/schedules', { ...body, name: 'night SHIFT' })).status, 409);
  assert.equal((await call(ids.hr, 'POST', '/schedules', { ...body, name: 'x', workDays: [] })).status, 400);
  assert.equal((await call(ids.hr, 'POST', '/schedules', { ...body, name: 'y', start: '25:00' })).status, 400);
  const id = made.json.schedule.id;
  assert.equal((await call(ids.hr, 'PUT', `/people/${ids.cy}/schedule`, { scheduleId: id })).status, 200);
  assert.equal((await call(ids.cy, 'GET', '/today')).json.schedule.name, 'Night shift');
  assert.equal((await call(ids.hr, 'GET', '/schedules')).json.schedules.find((s) => s.id === id).people, 1);
  const defaultId = list[0].id;
  assert.equal((await call(ids.hr, 'DELETE', `/schedules/${defaultId}`)).status, 400, 'the default cannot be deleted');
  assert.equal((await call(ids.hr, 'PUT', `/schedules/${id}/default`)).status, 200);
  assert.equal((await call(ids.hr, 'DELETE', `/schedules/${defaultId}`)).status, 200, 'now it can');
  assert.equal((await call(ids.ann, 'GET', '/today')).json.schedule.name, 'Night shift', 'people with no schedule follow the default');
  assert.equal((await call(ids.hr, 'PUT', `/people/${ids.cy}/schedule`, { scheduleId: null })).status, 200);
  // put the regular schedule back as the default for the tests that follow
  await admin.query('UPDATE work_schedules SET is_default = false');
  await admin.query("INSERT INTO work_schedules (name, start_time, end_time, is_default) VALUES ('Regular (9:00 to 18:00)', '09:00', '18:00', true)");
});

test('the payroll-ready export: a summary per employee, a daily detail, and limits', async (t) => {
  if (skip(t)) return;
  const mon = pastMonday();
  const q = `from=${iso(mon)}&to=${iso(addDays(mon, 6))}`;
  assert.equal((await call(ids.ann, 'GET', `/export?${q}`)).status, 403);
  assert.equal((await call(ids.hr, 'GET', '/export?from=2026-01-01&to=2026-12-31')).status, 400);
  const out = await call(ids.hr, 'GET', `/export?${q}`);
  assert.equal(out.status, 200);
  const lines = out.json.csv.split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'Employee no.,Name,Department,Period from,Period to,Scheduled days,Days present,Days absent,Paid leave days,Unpaid leave days,Holidays,Late (min),Times late,Undertime (min),Hours worked,Overtime (hours),Rest day / holiday hours,Days without clock-out');
  assert.equal(lines.length - 1, out.json.count);
  const ann = lines.find((l) => l.includes(',F ANN') || l.includes('F ANN'.replace(' ', ' ')));
  assert.ok(ann, 'a row for ann');
  const cells = ann.split(',');
  assert.deepEqual([cells[5], cells[6], cells[7], cells[8], cells[9], cells[10], cells[11]], ['4', '2', '0', '1', '1', '1', '30']);

  const detail = await call(ids.hr, 'GET', `/export?${q}&detail=1`);
  const dl = detail.json.csv.split('\r\n').filter(Boolean);
  assert.equal(dl[0].split(',')[3], 'Date');
  assert.ok(dl.some((l) => l.includes(iso(mon)) && l.includes('present') && l.includes('09:30') && l.includes('18:45')));
});

test('people are only judged between their hire date and last day', async (t) => {
  if (skip(t)) return;
  const mon = pastMonday();
  const newcomer = (await admin.query(
    "INSERT INTO users (username, email, password_hash, hire_date) VALUES ('newcomer', 'nc@x.test', 'x', $1) RETURNING id", [iso(addDays(mon, 2))]
  )).rows[0].id;
  const sheet = (await call(ids.hr, 'GET', `/timesheet?userId=${newcomer}&from=${iso(mon)}&to=${iso(addDays(mon, 4))}`)).json;
  assert.deepEqual(sheet.days.map((d) => d.status), ['n/a', 'n/a', 'absent', 'holiday', 'absent'], 'not absent before they were hired');
  assert.equal(sheet.totals.scheduledDays, 2);
  await admin.query('UPDATE users SET separation_date = $1 WHERE id = $2', [iso(addDays(mon, 2)), newcomer]);
  const left = (await call(ids.hr, 'GET', `/timesheet?userId=${newcomer}&from=${iso(mon)}&to=${iso(addDays(mon, 4))}`)).json;
  assert.deepEqual(left.days.map((d) => d.status), ['n/a', 'n/a', 'absent', 'n/a', 'n/a'], 'nor after their last day');
});
