// Attendance: clocking (several times a day), devices and networks, timesheets, corrections, schedules and the
// payroll-ready export, against a real PostgreSQL (scratch database).
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
const emitted = [];

const DAY = 24 * 60 * 60 * 1000;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
// A Monday in the past (last week's), so every day of that week is over whatever today is
function pastMonday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return addDays(d, -(((d.getUTCDay() + 6) % 7) + 7));
}
const mondayText = () => iso(pastMonday());
const split = (a = '08:00', b = '12:00', c = '13:00', d = '17:00') => [{ in: a, out: b }, { in: c, out: d }];

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
  const user = async (name, { hr = false, manager = null, level = 'rank_and_file' } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_hr, manager_id, job_level, last_name, first_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [name, `${name}@x.test`, 'x', hr, manager, level, name.toUpperCase(), 'F']
  )).rows[0].id;
  ids.hr = await user('hana', { hr: true });
  ids.lead = await user('lead', { level: 'managerial' });
  ids.ann = await user('ann', { manager: ids.lead });
  ids.bob = await user('bob', { manager: ids.lead });
  ids.cy = await user('cy');
  ids.guest = (await admin.query("INSERT INTO users (username, email, password_hash, account_type) VALUES ('visitor', 'v@x.test', 'x', 'guest') RETURNING id")).rows[0].id;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
    next();
  });
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

const call = async (userId, method, path, body, extraHeaders = {}) => {
  const res = await fetch(`${baseUrl}/api/attendance${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const device = (id, name = 'Test PC') => ({ 'X-Device-Id': id, 'X-Device-Name': name });
const PC = '11111111-aaaa-4bbb-8ccc-000000000001';
const PHONE = '22222222-aaaa-4bbb-8ccc-000000000002';

test('several clock-ins a day: in, out for lunch, in again, out; never two open at once', async (t) => {
  if (skip(t)) return;
  const first = await call(ids.cy, 'GET', '/today');
  assert.equal(first.status, 200);
  assert.equal(first.json.timezone, 'Asia/Manila');
  assert.equal(first.json.schedule.start, '08:00');
  assert.equal(first.json.clockedIn, false);
  assert.equal(first.json.today, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()), 'today is the company\'s date');

  assert.equal((await call(ids.cy, 'POST', '/clock-out', {}, device(PC))).status, 400, 'not clocked in yet');
  assert.equal((await call(ids.cy, 'POST', '/clock-in', {}, device(PC))).status, 201);
  assert.equal((await call(ids.cy, 'POST', '/clock-in', {}, device(PC))).status, 409, 'already in');
  assert.equal((await call(ids.cy, 'POST', '/clock-out', {}, device(PC))).json.clockedIn, false);
  assert.equal((await call(ids.cy, 'POST', '/clock-out', {}, device(PC))).status, 400, 'already out');
  const again = await call(ids.cy, 'POST', '/clock-in', {}, device(PC));
  assert.equal(again.status, 201, 'back from lunch');
  assert.equal(again.json.clockedIn, true);
  await call(ids.cy, 'POST', '/clock-out', {}, device(PC));
  assert.equal((await call(ids.cy, 'GET', '/today')).json.day.punches.length, 2, 'two stretches today');
  assert.equal((await call(ids.guest, 'POST', '/clock-in', {}, device(PC))).status, 403);
});

test('the IP address is recorded on every clock-in and clock-out, and only HR sees it', async (t) => {
  if (skip(t)) return;
  const row = (await admin.query('SELECT p.in_ip, p.out_ip FROM attendance_punches p JOIN attendance_records r ON r.id = p.record_id WHERE r.user_id = $1 ORDER BY p.id', [ids.cy])).rows;
  assert.equal(row.length, 2);
  assert.ok(row.every((r) => r.in_ip === '127.0.0.1' && r.out_ip === '127.0.0.1'), 'both taps of both stretches');
  const today = (await call(ids.cy, 'GET', '/today')).json.today;
  const mine = (await call(ids.cy, 'GET', `/timesheet?from=${today}&to=${today}`)).json.days[0];
  assert.equal(mine.punches[0].inIp, undefined, 'the employee does not get addresses');
  const hr = (await call(ids.hr, 'GET', `/timesheet?userId=${ids.cy}&from=${today}&to=${today}`)).json.days[0];
  assert.equal(hr.punches[0].inIp, '127.0.0.1');
  const board = (await call(ids.hr, 'GET', `/board?date=${today}`)).json.rows.find((r) => r.username === 'cy');
  assert.equal(board.punches[0].outIp, '127.0.0.1');
});

test('devices: the first is trusted, another is flagged until HR approves it, a missing id is flagged too', async (t) => {
  if (skip(t)) return;
  const today = (await call(ids.cy, 'GET', '/today')).json.today;
  const flag = async () => (await call(ids.hr, 'GET', `/timesheet?userId=${ids.cy}&from=${today}&to=${today}`)).json.days[0].deviceFlag;
  assert.equal(await flag(), false, 'everything so far was the first device');
  assert.equal((await call(ids.hr, 'GET', '/devices/pending')).json.devices.filter((d) => d.username === 'cy').length, 0);

  assert.equal((await call(ids.cy, 'POST', '/clock-in', {}, device(PHONE, 'New phone'))).status, 201, 'a new phone may clock in');
  await call(ids.cy, 'POST', '/clock-out', {}, device(PHONE, 'New phone'));
  assert.equal(await flag(), true, 'but it is flagged');
  const pending = (await call(ids.hr, 'GET', '/devices/pending')).json.devices.filter((d) => d.username === 'cy');
  assert.deepEqual(pending.map((d) => [d.name, d.trusted, d.punches]), [['New phone', false, 1]]);
  assert.equal((await call(ids.ann, 'GET', '/devices/pending')).status, 403);
  assert.equal((await call(ids.cy, 'PUT', `/devices/${pending[0].id}`, { trusted: true })).status, 403, 'you cannot approve your own phone');

  const approved = await call(ids.hr, 'PUT', `/devices/${pending[0].id}`, { trusted: true });
  assert.equal(approved.json.device.trusted, true);
  assert.equal(await flag(), false, 'approving clears the flag, including on earlier days');
  assert.equal((await call(ids.hr, 'GET', '/devices/pending')).json.devices.filter((d) => d.username === 'cy').length, 0);
  assert.equal((await call(ids.hr, 'GET', `/devices?userId=${ids.cy}`)).json.devices.length, 2);

  await call(ids.cy, 'POST', '/clock-in', {}); // no device id at all
  await call(ids.cy, 'POST', '/clock-out', {});
  assert.equal(await flag(), true, 'an unknown device is flagged');
  await admin.query("DELETE FROM attendance_punches p USING attendance_records r WHERE p.record_id = r.id AND r.user_id = $1 AND p.in_device = ''", [ids.cy]);
  assert.equal(await flag(), false);
  // forgetting every device makes the next one the trusted first again
  for (const d of (await call(ids.hr, 'GET', `/devices?userId=${ids.cy}`)).json.devices) assert.equal((await call(ids.hr, 'DELETE', `/devices/${d.id}`)).status, 200);
  assert.equal((await call(ids.hr, 'DELETE', '/devices/99999')).status, 404);
});

test('office network rule: only listed networks may clock, exempt people may clock anywhere, and it cannot be switched on empty', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.ann, 'GET', '/networks')).status, 403);
  assert.equal((await call(ids.hr, 'PUT', '/network-policy', { enforced: true })).status, 400, 'add a network first');
  assert.equal((await call(ids.hr, 'POST', '/networks', { label: 'Main office', cidr: 'office' })).status, 400);
  assert.equal((await call(ids.hr, 'POST', '/networks', { label: 'x', cidr: '10.0.0.0/33' })).status, 400);
  assert.equal((await call(ids.hr, 'POST', '/networks', { label: '', cidr: '10.0.0.0/8' })).status, 400);
  const branch = await call(ids.hr, 'POST', '/networks', { label: 'Branch', cidr: '10.20.0.0/16' });
  assert.equal(branch.status, 201);
  assert.equal((await call(ids.hr, 'POST', '/networks', { label: 'Again', cidr: '10.20.0.0/16' })).status, 409);
  const view = (await call(ids.hr, 'GET', '/networks')).json;
  assert.equal(view.myIp, '127.0.0.1');
  assert.equal(view.myIpAllowed, false, 'this computer is not in the list yet');

  assert.equal((await call(ids.hr, 'PUT', '/network-policy', { enforced: true })).json.enforced, true);
  const blocked = await call(ids.bob, 'POST', '/clock-in', {}, device(PC));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'network');
  assert.equal((await call(ids.bob, 'GET', '/today')).json.network.allowed, false, 'the app can say so before they tap');

  await admin.query('UPDATE users SET remote_clock = true WHERE id = $1', [ids.bob]);
  assert.equal((await call(ids.bob, 'POST', '/clock-in', {}, device(PC))).status, 201, 'an exempt (remote) employee can clock anywhere');
  await call(ids.bob, 'POST', '/clock-out', {}, device(PC));
  await admin.query('UPDATE users SET remote_clock = false WHERE id = $1', [ids.bob]);

  const office = await call(ids.hr, 'POST', '/networks', { label: 'Main office', cidr: '127.0.0.1' });
  assert.equal((await call(ids.ann, 'POST', '/clock-in', {}, device(PC))).status, 201, 'from a listed address');
  await call(ids.ann, 'POST', '/clock-out', {}, device(PC));
  await call(ids.hr, 'DELETE', `/networks/${branch.json.network.id}`);
  assert.equal((await call(ids.hr, 'DELETE', `/networks/${office.json.network.id}`)).status, 400, 'not the last one while the rule is on');
  assert.equal((await call(ids.hr, 'PUT', '/network-policy', { enforced: false })).json.enforced, false);
  assert.equal((await call(ids.hr, 'DELETE', `/networks/${office.json.network.id}`)).status, 200);
  await admin.query("DELETE FROM attendance_records WHERE user_id = ANY($1::int[]) AND work_date = (NOW() AT TIME ZONE 'Asia/Manila')::date", [[ids.ann, ids.bob]]);
});

test('HR sets a day with several punches; late, over break, undertime and overtime follow the schedule', async (t) => {
  if (skip(t)) return;
  const mon = mondayText();
  assert.equal((await call(ids.ann, 'PUT', '/records', { userId: ids.ann, date: mon, punches: split() })).status, 403, 'not even for yourself');
  const normal = await call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: mon, punches: split(), note: 'Imported' });
  assert.equal(normal.status, 200);
  assert.deepEqual([normal.json.day.status, normal.json.day.lateMinutes, normal.json.day.overBreakMinutes, normal.json.day.workedMinutes, normal.json.day.source], ['present', 0, 0, 480, 'hr']);
  assert.deepEqual(normal.json.day.punches.map((p) => [p.in, p.out]), [['08:00', '12:00'], ['13:00', '17:00']]);

  const tue = iso(addDays(pastMonday(), 1));
  const messy = await call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: tue, punches: split('08:30', '12:00', '13:25', '16:00') });
  assert.deepEqual([messy.json.day.lateMinutes, messy.json.day.overBreakMinutes, messy.json.day.undertimeMinutes], [30, 25, 60]);

  const wed = iso(addDays(pastMonday(), 2));
  const rankFile = await call(ids.hr, 'PUT', '/records', { userId: ids.bob, date: wed, punches: split('08:00', '12:00', '13:00', '19:00') });
  assert.equal(rankFile.json.day.overtimeMinutes, 120, 'rank and file earn overtime past the end');
  const manager = await call(ids.hr, 'PUT', '/records', { userId: ids.lead, date: wed, punches: split('08:00', '12:00', '13:00', '19:00') });
  assert.deepEqual([manager.json.day.overtimeMinutes, manager.json.day.afterHoursMinutes, manager.json.day.workedMinutes], [0, 120, 600], 'a manager gets none, though the hours count');

  const night = await call(ids.hr, 'PUT', '/records', { userId: ids.cy, date: mon, punches: [{ in: '22:00', out: '06:00' }] });
  assert.equal(night.json.day.workedMinutes, 8 * 60 - 60, 'a clock-out before the clock-in is the next morning');

  const bad = (punches) => call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: mon, punches });
  assert.equal((await bad([])).status, 400);
  assert.equal((await bad([{ in: '9:00', out: '12:00' }])).status, 400, 'times look like 09:00');
  assert.equal((await bad([{ in: '08:00' }, { in: '13:00', out: '17:00' }])).status, 400, 'only the last may be open');
  assert.equal((await bad(Array.from({ length: 11 }, (_, i) => ({ in: `0${i % 10}:00`, out: `0${i % 10}:30` })))).status, 400, 'at most 10');
  assert.equal((await call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: '2026-02-30', punches: split() })).status, 400);
  const open = await call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: mon, punches: [{ in: '08:00', out: '12:00' }, { in: '13:00' }] });
  assert.equal(open.json.day.status, 'incomplete', 'a past day with an open stretch');
  await call(ids.hr, 'PUT', '/records', { userId: ids.ann, date: mon, punches: split() });
});

test('absent, on leave and holiday days; the timesheet adds it all up', async (t) => {
  if (skip(t)) return;
  const mon = pastMonday();
  const thu = iso(addDays(mon, 3));
  await admin.query("INSERT INTO company_holidays (day, name) VALUES ($1, 'Test Holiday') ON CONFLICT DO NOTHING", [thu]);
  const vacation = (await admin.query("SELECT id FROM leave_types WHERE name = 'Vacation Leave'")).rows[0].id;
  const unpaid = (await admin.query("SELECT id FROM leave_types WHERE name = 'Unpaid Leave'")).rows[0].id;
  await admin.query("INSERT INTO leave_requests (user_id, leave_type_id, start_date, end_date, days, status) VALUES ($1, $2, $3, $3, 1, 'approved')", [ids.ann, vacation, iso(addDays(mon, 2))]);
  await admin.query("INSERT INTO leave_requests (user_id, leave_type_id, start_date, end_date, days, status) VALUES ($1, $2, $3, $3, 1, 'approved')", [ids.ann, unpaid, iso(addDays(mon, 4))]);

  const sheet = await call(ids.ann, 'GET', `/timesheet?from=${iso(mon)}&to=${iso(addDays(mon, 6))}`);
  assert.equal(sheet.status, 200);
  const by = Object.fromEntries(sheet.json.days.map((d) => [d.date, d.status]));
  assert.deepEqual([by[iso(mon)], by[iso(addDays(mon, 1))], by[iso(addDays(mon, 2))], by[thu], by[iso(addDays(mon, 4))], by[iso(addDays(mon, 5))]], ['present', 'present', 'leave', 'holiday', 'leave', 'rest']);
  const t1 = sheet.json.totals;
  assert.deepEqual([t1.scheduledDays, t1.presentDays, t1.absentDays, t1.paidLeaveDays, t1.unpaidLeaveDays, t1.holidays, t1.lateMinutes, t1.overBreakMinutes], [4, 2, 0, 1, 1, 1, 30, 25]);
  assert.equal(sheet.json.days[0].punches.length, 2);
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
});

test('the board: HR sees everyone, a manager sees their team, others see nobody', async (t) => {
  if (skip(t)) return;
  const date = mondayText();
  const all = (await call(ids.hr, 'GET', `/board?date=${date}`)).json;
  assert.equal(all.scope, 'all');
  const ann = all.rows.find((r) => r.username === 'ann');
  assert.deepEqual([ann.status, ann.clockIn, ann.clockOut, ann.lateMinutes], ['present', '08:00', '17:00', 0]);
  const team = (await call(ids.lead, 'GET', `/board?date=${date}`)).json;
  assert.deepEqual(team.rows.map((r) => r.username).sort(), ['ann', 'bob']);
  assert.equal((await call(ids.cy, 'GET', `/board?date=${date}`)).json.rows.length, 0);
  assert.equal((await call(ids.hr, 'GET', '/board?date=nope')).status, 400);
});

test('corrections: an employee asks, their manager or HR decides, approval rewrites the day', async (t) => {
  if (skip(t)) return;
  const day = iso(addDays(pastMonday(), 1)); // Tuesday: the messy day
  const ask = (body, who = ids.ann) => call(who, 'POST', '/corrections', body);
  const good = { date: day, punches: split('08:00', '12:00', '13:00', '17:00'), reason: 'Forgot to clock out after lunch' };
  assert.equal((await ask({ ...good, reason: ' ' })).status, 400, 'a reason is needed');
  assert.equal((await ask({ ...good, punches: [] })).status, 400);
  assert.equal((await ask({ ...good, date: '2099-01-01' })).status, 400, 'not the future');
  assert.equal((await ask({ ...good, date: '2020-01-06' })).status, 400, 'only the last 31 days');
  assert.equal((await ask({ ...good, date: 'x' })).status, 400);

  emitted.length = 0;
  const made = await ask(good);
  assert.equal(made.status, 201);
  const id = made.json.correction.id;
  assert.deepEqual(emitted.filter((e) => e.event === 'attendance_updated').map((e) => e.room).sort(), [`user_${ids.hr}`, `user_${ids.lead}`].sort(), 'the manager and HR are told');
  assert.equal((await ask(good)).status, 409, 'one waiting request per day');
  assert.ok((await call(ids.lead, 'GET', '/corrections/queue')).json.corrections.some((c) => c.id === id), 'in the manager\'s queue');
  assert.equal((await call(ids.bob, 'GET', '/corrections/queue')).json.corrections.length, 0, 'not in a colleague\'s');
  assert.equal((await call(ids.ann, 'PUT', `/corrections/${id}/decision`, { status: 'approved' })).status, 403, 'not your own');
  assert.equal((await call(ids.bob, 'PUT', `/corrections/${id}/decision`, { status: 'approved' })).status, 403, 'not a colleague');
  assert.equal((await call(ids.lead, 'PUT', `/corrections/${id}/decision`, { status: 'later' })).status, 400);

  const before = (await call(ids.hr, 'GET', `/timesheet?userId=${ids.ann}&from=${day}&to=${day}`)).json.days[0];
  assert.equal(before.undertimeMinutes, 60);
  const approved = await call(ids.lead, 'PUT', `/corrections/${id}/decision`, { status: 'approved', note: 'OK' });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.correction.decidedBy, 'lead');
  const after = (await call(ids.hr, 'GET', `/timesheet?userId=${ids.ann}&from=${day}&to=${day}`)).json.days[0];
  assert.deepEqual([after.undertimeMinutes, after.overBreakMinutes, after.lateMinutes, after.source], [0, 0, 0, 'correction']);
  assert.match(after.note, /Forgot to clock out/);
  assert.equal((await call(ids.hr, 'PUT', `/corrections/${id}/decision`, { status: 'rejected' })).status, 409, 'final');

  const wed = iso(addDays(pastMonday(), 2));
  const second = await ask({ date: wed, punches: split(), reason: 'Wrong times' }, ids.bob);
  assert.equal((await call(ids.hr, 'PUT', `/corrections/${second.json.correction.id}/decision`, { status: 'rejected', note: 'No proof' })).json.correction.status, 'rejected');
  assert.equal((await call(ids.hr, 'GET', `/timesheet?userId=${ids.bob}&from=${wed}&to=${wed}`)).json.days[0].overtimeMinutes, 120, 'a rejected request changes nothing');
  assert.equal((await call(ids.bob, 'GET', '/corrections/mine')).json.corrections[0].decisionNote, 'No proof');
  const third = await ask({ date: wed, punches: split(), reason: 'Again' }, ids.bob);
  assert.equal((await call(ids.bob, 'POST', `/corrections/${third.json.correction.id}/cancel`)).status, 200);
  assert.equal((await call(ids.bob, 'POST', `/corrections/${third.json.correction.id}/cancel`)).status, 404);
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
  const defaultId = list[0].id;
  assert.equal((await call(ids.hr, 'DELETE', `/schedules/${defaultId}`)).status, 400, 'the default cannot be deleted');
  assert.equal((await call(ids.hr, 'PUT', `/schedules/${id}/default`)).status, 200);
  assert.equal((await call(ids.hr, 'DELETE', `/schedules/${defaultId}`)).status, 200, 'now it can');
  assert.equal((await call(ids.ann, 'GET', '/today')).json.schedule.name, 'Night shift', 'people with no schedule follow the default');
  assert.equal((await call(ids.hr, 'PUT', `/people/${ids.cy}/schedule`, { scheduleId: null })).status, 200);
  // put the regular schedule back as the default for the tests that follow
  await admin.query('UPDATE work_schedules SET is_default = false');
  await admin.query("INSERT INTO work_schedules (name, start_time, end_time, is_default) VALUES ('Regular (8:00 to 17:00)', '08:00', '17:00', true)");
});

test('the payroll-ready export: level and overtime eligibility, break time, a summary per employee, a daily detail, limits', async (t) => {
  if (skip(t)) return;
  const mon = pastMonday();
  const q = `from=${iso(mon)}&to=${iso(addDays(mon, 6))}`;
  assert.equal((await call(ids.ann, 'GET', `/export?${q}`)).status, 403);
  assert.equal((await call(ids.hr, 'GET', '/export?from=2026-01-01&to=2026-12-31')).status, 400);
  const out = await call(ids.hr, 'GET', `/export?${q}`);
  assert.equal(out.status, 200);
  const lines = out.json.csv.split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'Employee no.,Name,Department,Level,Overtime eligible,Period from,Period to,Scheduled days,Days present,Days absent,Paid leave days,Unpaid leave days,Holidays,Late (min),Times late,Over break (min),Undertime (min),Hours worked,Overtime (hours),After-hours, not overtime (hours),Rest day / holiday hours,Days without clock-out');
  const row = (name) => lines.find((l) => l.includes(`F ${name}`)).split(',');
  const ann = row('ANN');
  assert.deepEqual([ann[3], ann[4], ann[8], ann[9], ann[10], ann[11], ann[12]], ['Rank and file', 'yes', '2', '0', '1', '1', '1']);
  const bob = row('BOB');
  assert.equal(bob[18], '2', 'rank and file: two overtime hours');
  const lead = row('LEAD');
  assert.deepEqual([lead[3], lead[4], lead[18], lead[19]], ['Managerial', 'no', '0', '2'], 'managerial: no overtime, the two hours shown as after-hours');

  const detail = await call(ids.hr, 'GET', `/export?${q}&detail=1`);
  const dl = detail.json.csv.split('\r\n').filter(Boolean);
  assert.ok(dl[0].includes('Clock-ins and outs'));
  assert.ok(dl.some((l) => l.includes(iso(mon)) && l.includes('08:00-12:00; 13:00-17:00')));
});

test('people are only judged between their hire date and last day', async (t) => {
  if (skip(t)) return;
  const mon = pastMonday();
  const newcomer = (await admin.query(
    "INSERT INTO users (username, email, password_hash, hire_date) VALUES ('newcomer', 'nc@x.test', 'x', $1) RETURNING id", [iso(addDays(mon, 2))]
  )).rows[0].id;
  const sheet = (await call(ids.hr, 'GET', `/timesheet?userId=${newcomer}&from=${iso(mon)}&to=${iso(addDays(mon, 4))}`)).json;
  assert.deepEqual(sheet.days.map((d) => d.status), ['n/a', 'n/a', 'absent', 'holiday', 'absent'], 'not absent before they were hired');
  await admin.query('UPDATE users SET separation_date = $1 WHERE id = $2', [iso(addDays(mon, 2)), newcomer]);
  const left = (await call(ids.hr, 'GET', `/timesheet?userId=${newcomer}&from=${iso(mon)}&to=${iso(addDays(mon, 4))}`)).json;
  assert.deepEqual(left.days.map((d) => d.status), ['n/a', 'n/a', 'absent', 'n/a', 'n/a'], 'nor after their last day');
});

test('an older database with one clock-in and clock-out per day keeps its records', async (t) => {
  if (skip(t)) return;
  const migrations = require('../src/migrations');
  // put the old shape back, with one record in it, and run the migrations again
  await admin.query('DROP TABLE attendance_punches CASCADE');
  await admin.query('DELETE FROM attendance_records'); // an old database has no rows without times
  await admin.query('ALTER TABLE attendance_records ADD COLUMN clock_in TIMESTAMPTZ, ADD COLUMN clock_out TIMESTAMPTZ');
  await admin.query("INSERT INTO attendance_records (user_id, work_date, source, clock_in, clock_out) VALUES ($1, '2026-01-05', 'self', '2026-01-05T00:05:00Z', '2026-01-05T09:00:00Z')", [ids.cy]);
  for (const statement of migrations) await admin.query(statement);
  const cols = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'attendance_records'")).rows.map((r) => r.column_name);
  assert.ok(!cols.includes('clock_in') && !cols.includes('clock_out'), 'the day row no longer holds the times');
  const punches = (await admin.query("SELECT p.clock_in, p.clock_out FROM attendance_punches p JOIN attendance_records r ON r.id = p.record_id WHERE r.user_id = $1 AND r.work_date = '2026-01-05'", [ids.cy])).rows;
  assert.equal(punches.length, 1, 'moved to a punch');
  assert.equal(punches[0].clock_in.toISOString(), '2026-01-05T00:05:00.000Z');
  await admin.query("UPDATE attendance_records SET source = 'correction' WHERE work_date = '2026-01-05'");
});
