// Attendance: clocking in and out, timesheets, the daily board, work schedules, and the payroll-ready export.
//
// Times are the company's (COMPANY_TIMEZONE, Asia/Manila unless set): "today" and the HH:MM people see and HR
// types are in that time zone, whatever the computer's clock says. The server's clock is the only one used for
// clocking in and out. The rules for late, undertime, overtime and absent days are in src/attendance.js.
const express = require('express');
const { query } = require('../db');
const config = require('../config');
const authenticateToken = require('../middleware/auth');
const { fail, canManageEmployees, requireHr } = require('../hr');
const { parseDay, eachDay, evaluateDay, totalsFor, round2 } = require('../attendance');
const { workingDaysBetween } = require('../leaveDays');

const router = express.Router();
router.use(authenticateToken);

const TZ = config.COMPANY_TIMEZONE;
const MAX_RANGE_DAYS = 62;
const MAX_OPEN_HOURS = 20; // clocking out later than this after clocking in starts a new day instead

const parseId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function member(userId) {
  const row = (await query(
    'SELECT id, username, account_type, is_superadmin, is_hr, manager_id, deactivated_at FROM users WHERE id = $1', [userId]
  )).rows[0];
  if (!row) throw fail(401, 'Account not found');
  if (row.account_type !== 'member' || row.deactivated_at) throw fail(403, 'Attendance is for workspace members');
  return row;
}

const companyToday = async () => (await query("SELECT to_char((NOW() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d", [TZ])).rows[0].d;

function text(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw fail(400, `${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw fail(400, `${label} can be at most ${max} characters`);
  return trimmed;
}

function timeOfDay(value, label) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw fail(400, `${label} must be a time like 09:00`);
  return value;
}

// ---- building days ----

// For these people over from..to: each day judged against their schedule, holidays and approved leave.
// Returns Map(userId -> { person, schedule, days: [evaluated day + clock times], totals }).
async function buildDays(userIds, from, to) {
  const today = await companyToday();
  const people = (await query(
    `SELECT u.id, u.username, u.first_name, u.middle_name, u.last_name, u.employee_no, u.department,
            to_char(u.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(u.separation_date, 'YYYY-MM-DD') AS separation_date,
            s.id AS schedule_id, s.name AS schedule_name, to_char(s.start_time, 'HH24:MI') AS start_text, to_char(s.end_time, 'HH24:MI') AS end_text,
            s.break_minutes, s.grace_minutes, s.overtime_min_minutes, s.work_days
     FROM users u
     JOIN work_schedules s ON s.id = COALESCE(u.schedule_id, (SELECT id FROM work_schedules WHERE is_default LIMIT 1))
     WHERE u.id = ANY($1::int[])`,
    [userIds]
  )).rows;

  const records = (await query(
    `SELECT r.user_id, to_char(r.work_date, 'YYYY-MM-DD') AS day, r.clock_in, r.clock_out, r.note, r.source,
            to_char(r.clock_in AT TIME ZONE $4, 'HH24:MI') AS in_text, to_char(r.clock_out AT TIME ZONE $4, 'HH24:MI') AS out_text,
            ((r.work_date + s.start_time) AT TIME ZONE $4) AS sched_start,
            ((r.work_date + s.end_time + CASE WHEN s.end_time > s.start_time THEN INTERVAL '0' ELSE INTERVAL '1 day' END) AT TIME ZONE $4) AS sched_end
     FROM attendance_records r
     JOIN users u ON u.id = r.user_id
     JOIN work_schedules s ON s.id = COALESCE(u.schedule_id, (SELECT id FROM work_schedules WHERE is_default LIMIT 1))
     WHERE r.user_id = ANY($1::int[]) AND r.work_date BETWEEN $2::date AND $3::date`,
    [userIds, from, to, TZ]
  )).rows;
  const recordOf = new Map(records.map((r) => [`${r.user_id}|${r.day}`, r]));

  const holidayRows = (await query("SELECT to_char(day, 'YYYY-MM-DD') AS day FROM company_holidays WHERE day BETWEEN $1::date AND $2::date", [from, to])).rows;
  const holidays = new Set(holidayRows.map((h) => h.day));

  // approved leave, one amount per working day (a half day is 0.5), split into paid and unpaid
  const leave = (await query(
    `SELECT r.user_id, to_char(r.start_date, 'YYYY-MM-DD') AS start_date, to_char(r.end_date, 'YYYY-MM-DD') AS end_date, r.half_day, t.paid
     FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
     WHERE r.status = 'approved' AND r.user_id = ANY($1::int[]) AND r.start_date <= $3::date AND r.end_date >= $2::date`,
    [userIds, from, to]
  )).rows;
  const leaveByUser = new Map();
  for (const r of leave) {
    const entry = leaveByUser.get(r.user_id) || { all: new Map(), paid: new Map(), unpaid: new Map() };
    for (const d of workingDaysBetween(r.start_date, r.end_date, holidays)) {
      if (d < from || d > to) continue;
      const amount = r.half_day ? 0.5 : 1;
      entry.all.set(d, (entry.all.get(d) || 0) + amount);
      const bucket = r.paid ? entry.paid : entry.unpaid;
      bucket.set(d, (bucket.get(d) || 0) + amount);
    }
    leaveByUser.set(r.user_id, entry);
  }

  const out = new Map();
  for (const p of people) {
    const base = { workDays: p.work_days, breakMinutes: p.break_minutes, graceMinutes: p.grace_minutes, overtimeMinMinutes: p.overtime_min_minutes };
    const entry = leaveByUser.get(p.id) || { all: new Map(), paid: new Map(), unpaid: new Map() };
    const days = eachDay(from, to).map((date) => {
      if ((p.hire_date && date < p.hire_date) || (p.separation_date && date > p.separation_date)) {
        return { date, status: 'n/a', isWorkDay: false, isHoliday: false, leave: 0, lateMinutes: 0, undertimeMinutes: 0, workedMinutes: 0, overtimeMinutes: 0, premiumMinutes: 0, absentDays: 0 };
      }
      const rec = recordOf.get(`${p.id}|${date}`);
      const evaluated = evaluateDay({
        date, today, isHoliday: holidays.has(date), leave: Math.min(1, entry.all.get(date) || 0),
        record: rec ? { clockIn: rec.clock_in, clockOut: rec.clock_out } : null,
        schedule: { ...base, start: rec ? rec.sched_start : null, end: rec ? rec.sched_end : null },
      });
      return {
        ...evaluated,
        clockIn: rec ? rec.in_text : null, clockOut: rec ? rec.out_text : null, note: rec ? rec.note : '', source: rec ? rec.source : null,
      };
    });
    out.set(p.id, {
      person: {
        id: p.id, username: p.username, firstName: p.first_name || '', middleName: p.middle_name || '', lastName: p.last_name || '',
        employeeNo: p.employee_no || '', department: p.department || '',
      },
      schedule: { id: p.schedule_id, name: p.schedule_name, start: p.start_text, end: p.end_text, breakMinutes: p.break_minutes, graceMinutes: p.grace_minutes, workDays: p.work_days },
      days,
      totals: totalsFor(days, { paidLeave: entry.paid, unpaidLeave: entry.unpaid }),
    });
  }
  return out;
}

// who may look at whose attendance: themselves, their manager, HR / Superadmin
async function mayView(actor, targetId) {
  if (actor.id === targetId || canManageEmployees(actor)) return true;
  const row = (await query('SELECT 1 FROM users WHERE id = $1 AND manager_id = $2', [targetId, actor.id])).rows[0];
  return Boolean(row);
}

function monthRange(month) {
  const m = typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  if (!m) return null;
  const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return { from: `${m}-01`, to: last };
}

function rangeFrom(queryParams, { max = MAX_RANGE_DAYS } = {}) {
  let from;
  let to;
  if (queryParams.month) {
    const range = monthRange(queryParams.month);
    if (!range) throw fail(400, 'month must look like 2026-11');
    ({ from, to } = range);
  } else {
    if (!parseDay(queryParams.from) || !parseDay(queryParams.to)) throw fail(400, 'Choose a start and an end date');
    from = queryParams.from;
    to = queryParams.to;
  }
  if (to < from) throw fail(400, 'The end date is before the start date');
  if (eachDay(from, to).length > max) throw fail(400, `Choose at most ${max} days at a time`);
  return { from, to };
}

// ---- clocking ----

async function currentState(userId) {
  const today = await companyToday();
  const open = (await query(
    `SELECT id, to_char(work_date, 'YYYY-MM-DD') AS day, to_char(clock_in AT TIME ZONE $2, 'HH24:MI') AS in_text,
            to_char(clock_out AT TIME ZONE $2, 'HH24:MI') AS out_text, clock_in, clock_out
     FROM attendance_records WHERE user_id = $1 AND (work_date = $3::date OR (clock_out IS NULL AND clock_in > NOW() - ($4 || ' hours')::interval))
     ORDER BY work_date DESC LIMIT 1`,
    [userId, TZ, today, String(MAX_OPEN_HOURS)]
  )).rows[0];
  const days = await buildDays([userId], today, today);
  const mine = days.get(userId);
  return {
    today, timezone: TZ, schedule: mine ? mine.schedule : null,
    record: open ? { day: open.day, clockIn: open.in_text, clockOut: open.out_text, open: !open.clock_out, clockInAt: open.clock_in } : null,
    day: mine ? mine.days[0] : null,
    isManager: (await query('SELECT 1 FROM users WHERE manager_id = $1 AND deactivated_at IS NULL LIMIT 1', [userId])).rows.length > 0,
  };
}

router.get('/today', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    res.json(await currentState(actor.id));
  } catch (err) {
    sendError(res, err, 'Attendance today error');
  }
});

router.post('/clock-in', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const today = await companyToday();
    const inserted = await query(
      `INSERT INTO attendance_records (user_id, work_date, clock_in, source) VALUES ($1, $2::date, NOW(), 'self')
       ON CONFLICT (user_id, work_date) DO NOTHING RETURNING id`,
      [actor.id, today]
    );
    if (!inserted.rows.length) throw fail(409, 'You already clocked in today');
    res.status(201).json(await currentState(actor.id));
  } catch (err) {
    sendError(res, err, 'Clock in error');
  }
});

router.post('/clock-out', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const updated = await query(
      `UPDATE attendance_records SET clock_out = NOW()
       WHERE id = (SELECT id FROM attendance_records WHERE user_id = $1 AND clock_out IS NULL AND clock_in > NOW() - ($2 || ' hours')::interval ORDER BY clock_in DESC LIMIT 1)
       RETURNING id`,
      [actor.id, String(MAX_OPEN_HOURS)]
    );
    if (!updated.rows.length) throw fail(400, 'You are not clocked in');
    res.json(await currentState(actor.id));
  } catch (err) {
    sendError(res, err, 'Clock out error');
  }
});

// ---- timesheets and the board ----

// GET /api/attendance/timesheet?userId=&month=2026-11 (or from=&to=) - mine, my reports', or anyone's for HR
router.get('/timesheet', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const targetId = req.query.userId === undefined ? actor.id : parseId(req.query.userId);
    if (targetId === null) throw fail(400, 'A valid person ID is required');
    if (!(await mayView(actor, targetId))) throw fail(403, 'You can only see your own attendance and your team\'s');
    const { from, to } = rangeFrom(req.query.month || req.query.from ? req.query : { month: (await companyToday()).slice(0, 7) });
    const result = (await buildDays([targetId], from, to)).get(targetId);
    if (!result) throw fail(404, 'Person not found');
    res.json({ from, to, timezone: TZ, ...result });
  } catch (err) {
    sendError(res, err, 'Timesheet error');
  }
});

// GET /api/attendance/board?date= - everyone today (HR) or my team (a manager): in, late, absent, on leave
router.get('/board', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const date = req.query.date ? (parseDay(req.query.date) ? req.query.date : null) : await companyToday();
    if (!date) throw fail(400, 'Choose a real date');
    const hr = canManageEmployees(actor);
    const people = (await query(
      `SELECT id FROM users WHERE account_type = 'member' AND deactivated_at IS NULL AND ($1::boolean OR manager_id = $2)`, [hr, actor.id]
    )).rows.map((r) => r.id);
    if (!people.length) return res.json({ date, timezone: TZ, scope: hr ? 'all' : 'team', rows: [] });
    const built = await buildDays(people, date, date);
    const rows = Array.from(built.values()).map((b) => ({ ...b.person, ...b.days[0], schedule: b.schedule }))
      .filter((r) => r.status !== 'n/a')
      .sort((a, b) => (a.lastName || a.username).localeCompare(b.lastName || b.username));
    return res.json({ date, timezone: TZ, scope: hr ? 'all' : 'team', rows });
  } catch (err) {
    return sendError(res, err, 'Attendance board error');
  }
});

// ---- HR: fix a day ----

// PUT /api/attendance/records - { userId, date, clockIn: 'HH:MM', clockOut: 'HH:MM' | null, note } (company time)
router.put('/records', async (req, res) => {
  try {
    const actor = await requireHr(req.user.userId);
    const body = req.body || {};
    const userId = parseId(body.userId);
    if (userId === null) throw fail(400, 'A valid person ID is required');
    if (!parseDay(body.date)) throw fail(400, 'Choose a real date');
    const clockIn = timeOfDay(body.clockIn, 'Clock in');
    const clockOut = body.clockOut === null || body.clockOut === undefined || body.clockOut === '' ? null : timeOfDay(body.clockOut, 'Clock out');
    const note = text(body.note, 200, 'Note');
    if (!(await query("SELECT 1 FROM users WHERE id = $1 AND account_type = 'member'", [userId])).rows.length) throw fail(404, 'Person not found');
    // a clock-out at or before the clock-in means the next morning (a night shift)
    await query(
      `INSERT INTO attendance_records (user_id, work_date, clock_in, clock_out, source, note, edited_by)
       VALUES ($1, $2::date, ($2::date + $3::time) AT TIME ZONE $6,
               CASE WHEN $4::time IS NULL THEN NULL WHEN $4::time > $3::time THEN ($2::date + $4::time) AT TIME ZONE $6 ELSE ($2::date + 1 + $4::time) AT TIME ZONE $6 END,
               'hr', $5, $7)
       ON CONFLICT (user_id, work_date) DO UPDATE SET clock_in = EXCLUDED.clock_in, clock_out = EXCLUDED.clock_out,
              source = 'hr', note = EXCLUDED.note, edited_by = EXCLUDED.edited_by`,
      [userId, body.date, clockIn, clockOut, note, TZ, actor.id]
    );
    const row = (await buildDays([userId], body.date, body.date)).get(userId);
    res.json({ day: row.days[0] });
  } catch (err) {
    sendError(res, err, 'Save attendance record error');
  }
});

router.delete('/records/:userId/:date', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const userId = parseId(req.params.userId);
    if (userId === null || !parseDay(req.params.date)) throw fail(400, 'A person and a date are required');
    const result = await query('DELETE FROM attendance_records WHERE user_id = $1 AND work_date = $2::date RETURNING id', [userId, req.params.date]);
    if (!result.rows.length) throw fail(404, 'No record for that day');
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 'Delete attendance record error');
  }
});

// ---- work schedules ----

const mapSchedule = (row) => ({
  id: row.id, name: row.name, start: row.start_text, end: row.end_text, breakMinutes: row.break_minutes, graceMinutes: row.grace_minutes,
  overtimeMinMinutes: row.overtime_min_minutes, workDays: row.work_days, isDefault: row.is_default, people: row.people,
});
const SCHEDULE_SELECT = `SELECT s.id, s.name, to_char(s.start_time, 'HH24:MI') AS start_text, to_char(s.end_time, 'HH24:MI') AS end_text,
    s.break_minutes, s.grace_minutes, s.overtime_min_minutes, s.work_days, s.is_default,
    (SELECT COUNT(*)::int FROM users u WHERE u.schedule_id = s.id OR (s.is_default AND u.schedule_id IS NULL)) AS people
  FROM work_schedules s`;

router.get('/schedules', async (req, res) => {
  try {
    await member(req.user.userId);
    const result = await query(`${SCHEDULE_SELECT} ORDER BY s.is_default DESC, LOWER(s.name)`);
    res.json({ schedules: result.rows.map(mapSchedule), timezone: TZ });
  } catch (err) {
    sendError(res, err, 'List schedules error');
  }
});

function cleanSchedule(body) {
  const name = text(body.name, 60, 'Name');
  if (!name) throw fail(400, 'A schedule needs a name');
  const small = (value, label, max) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > max) throw fail(400, `${label} must be a whole number from 0 to ${max}`);
    return n;
  };
  if (!Array.isArray(body.workDays) || !body.workDays.length || body.workDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw fail(400, 'Choose the work days (0 is Sunday, 6 is Saturday)');
  }
  return {
    name, start: timeOfDay(body.start, 'Start'), end: timeOfDay(body.end, 'End'),
    breakMinutes: small(body.breakMinutes === undefined ? 60 : body.breakMinutes, 'Break', 240),
    graceMinutes: small(body.graceMinutes === undefined ? 10 : body.graceMinutes, 'Grace', 120),
    overtimeMinMinutes: small(body.overtimeMinMinutes === undefined ? 30 : body.overtimeMinMinutes, 'Overtime threshold', 240),
    workDays: Array.from(new Set(body.workDays)).sort(),
  };
}

router.post('/schedules', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const s = cleanSchedule(req.body || {});
    if ((await query('SELECT 1 FROM work_schedules WHERE LOWER(name) = LOWER($1)', [s.name])).rows.length) throw fail(409, 'There is already a schedule with that name');
    const created = await query(
      `INSERT INTO work_schedules (name, start_time, end_time, break_minutes, grace_minutes, overtime_min_minutes, work_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [s.name, s.start, s.end, s.breakMinutes, s.graceMinutes, s.overtimeMinMinutes, s.workDays]
    );
    res.status(201).json({ schedule: mapSchedule((await query(`${SCHEDULE_SELECT} WHERE s.id = $1`, [created.rows[0].id])).rows[0]) });
  } catch (err) {
    sendError(res, err, 'Create schedule error');
  }
});

router.put('/schedules/:id', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid schedule ID is required');
    const s = cleanSchedule(req.body || {});
    if ((await query('SELECT 1 FROM work_schedules WHERE LOWER(name) = LOWER($1) AND id <> $2', [s.name, id])).rows.length) throw fail(409, 'There is already a schedule with that name');
    const result = await query(
      `UPDATE work_schedules SET name = $1, start_time = $2, end_time = $3, break_minutes = $4, grace_minutes = $5, overtime_min_minutes = $6, work_days = $7
       WHERE id = $8 RETURNING id`,
      [s.name, s.start, s.end, s.breakMinutes, s.graceMinutes, s.overtimeMinMinutes, s.workDays, id]
    );
    if (!result.rows.length) throw fail(404, 'Schedule not found');
    res.json({ schedule: mapSchedule((await query(`${SCHEDULE_SELECT} WHERE s.id = $1`, [id])).rows[0]) });
  } catch (err) {
    sendError(res, err, 'Update schedule error');
  }
});

router.delete('/schedules/:id', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid schedule ID is required');
    const found = (await query('SELECT is_default FROM work_schedules WHERE id = $1', [id])).rows[0];
    if (!found) throw fail(404, 'Schedule not found');
    if (found.is_default) throw fail(400, 'The default schedule cannot be deleted; make another one the default first');
    await query('DELETE FROM work_schedules WHERE id = $1', [id]); // people on it fall back to the default
    res.json({ id });
  } catch (err) {
    sendError(res, err, 'Delete schedule error');
  }
});

router.put('/schedules/:id/default', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid schedule ID is required');
    if (!(await query('SELECT 1 FROM work_schedules WHERE id = $1', [id])).rows.length) throw fail(404, 'Schedule not found');
    await query('UPDATE work_schedules SET is_default = (id = $1)', [id]);
    res.json({ id });
  } catch (err) {
    sendError(res, err, 'Set default schedule error');
  }
});

// PUT /api/attendance/people/:id/schedule - { scheduleId } (null: the default schedule)
router.put('/people/:id/schedule', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    const scheduleId = req.body && req.body.scheduleId === null ? null : parseId(req.body && req.body.scheduleId);
    if (scheduleId === null && !(req.body && req.body.scheduleId === null)) throw fail(400, 'scheduleId must be a schedule ID or null');
    if (scheduleId !== null && !(await query('SELECT 1 FROM work_schedules WHERE id = $1', [scheduleId])).rows.length) throw fail(404, 'Schedule not found');
    const result = await query("UPDATE users SET schedule_id = $1 WHERE id = $2 AND account_type = 'member' RETURNING id", [scheduleId, id]);
    if (!result.rows.length) throw fail(404, 'Person not found');
    res.json({ id, scheduleId });
  } catch (err) {
    sendError(res, err, 'Assign schedule error');
  }
});

// ---- the payroll-ready export ----

// A CSV cell: quoted when needed; one that could start a formula is defused.
function csvCell(value) {
  let cell = value === null || value === undefined ? '' : String(value);
  if (/^[=@\t\r]/.test(cell) || (/^[+-]/.test(cell) && !/^[+-][\d\s().-]+$/.test(cell))) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

const fullName = (p) => [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ') || p.username;

// GET /api/attendance/export?from=&to=&detail=1 - one row per employee for the period (or one per day with detail=1).
// Everything payroll needs to count: days, absences, leave (paid and unpaid), holidays, late, undertime, hours.
router.get('/export', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const { from, to } = rangeFrom(req.query);
    const people = (await query(
      `SELECT id FROM users WHERE account_type = 'member' AND (deactivated_at IS NULL OR deactivated_at >= $1::date)`, [from]
    )).rows.map((r) => r.id);
    const built = people.length ? await buildDays(people, from, to) : new Map();
    const list = Array.from(built.values()).sort((a, b) => (a.person.lastName || a.person.username).localeCompare(b.person.lastName || b.person.username));
    const lines = [];
    if (req.query.detail === '1') {
      lines.push(['Employee no.', 'Name', 'Department', 'Date', 'Status', 'Clock in', 'Clock out', 'Late (min)', 'Undertime (min)', 'Hours worked', 'Overtime (min)', 'Rest day / holiday hours', 'Leave days', 'Note'].join(','));
      for (const b of list) {
        for (const d of b.days.filter((x) => x.status !== 'n/a')) {
          lines.push([b.person.employeeNo, fullName(b.person), b.person.department, d.date, d.status, d.clockIn, d.clockOut, d.lateMinutes, d.undertimeMinutes,
            round2(d.workedMinutes / 60), d.overtimeMinutes, round2(d.premiumMinutes / 60), d.leave, d.note].map(csvCell).join(','));
        }
      }
    } else {
      lines.push(['Employee no.', 'Name', 'Department', 'Period from', 'Period to', 'Scheduled days', 'Days present', 'Days absent', 'Paid leave days', 'Unpaid leave days',
        'Holidays', 'Late (min)', 'Times late', 'Undertime (min)', 'Hours worked', 'Overtime (hours)', 'Rest day / holiday hours', 'Days without clock-out'].join(','));
      for (const b of list) {
        const t = b.totals;
        lines.push([b.person.employeeNo, fullName(b.person), b.person.department, from, to, t.scheduledDays, t.presentDays, t.absentDays, t.paidLeaveDays, t.unpaidLeaveDays,
          t.holidays, t.lateMinutes, t.lateCount, t.undertimeMinutes, t.workedHours, t.overtimeHours, t.premiumHours, t.incompleteDays].map(csvCell).join(','));
      }
    }
    res.json({ csv: `${lines.join('\r\n')}\r\n`, count: list.length, from, to });
  } catch (err) {
    sendError(res, err, 'Export attendance error');
  }
});

module.exports = router;
