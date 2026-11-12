// Attendance: clocking in and out (several times a day), timesheets, the daily board, work schedules, corrections,
// the office-network rule, device review, and the payroll-ready export.
//
// People clock in and out as often as they leave and come back: in 8:00, out 12:00, in 13:00, out 17:00. Each pair is a
// "punch". Times are the company's (COMPANY_TIMEZONE, Asia/Manila unless set): "today" and the HH:MM people see and HR
// types are in that time zone, whatever the computer's clock says. The server's clock is the only one used for clocking.
// The rules for late, break, undertime, overtime and absent days are in src/attendance.js; the network and device
// rules in src/clockRules.js.
const express = require('express');
const { query } = require('../db');
const config = require('../config');
const authenticateToken = require('../middleware/auth');
const { fail, canManageEmployees, requireHr } = require('../hr');
const { parseDay, eachDay, evaluateDay, totalsFor, round2 } = require('../attendance');
const { workingDaysBetween } = require('../leaveDays');
const { normalizeIp, parseNetwork, ipAllowed, readDevice } = require('../clockRules');

const router = express.Router();
router.use(authenticateToken);

const TZ = config.COMPANY_TIMEZONE;
const MAX_RANGE_DAYS = 62;
const MAX_OPEN_HOURS = 20; // a stretch left open longer than this is not clocked out by a new tap
const MAX_PUNCHES = 10;
const MAX_CORRECTION_DAYS = 31;
const MAX_NETWORKS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const parseId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function member(userId) {
  const row = (await query(
    'SELECT id, username, account_type, is_superadmin, is_hr, manager_id, deactivated_at, remote_clock FROM users WHERE id = $1', [userId]
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

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// [{ in: '08:00', out: '12:00' }, { in: '13:00', out: null }] -> [{ inMin, outMin | null }] counted from midnight of the work date.
// Each time must come after the one before; going back past midnight (a night shift) means the next morning.
function cleanPunches(list) {
  if (!Array.isArray(list) || list.length === 0) throw fail(400, 'Add at least one clock-in');
  if (list.length > MAX_PUNCHES) throw fail(400, `At most ${MAX_PUNCHES} clock-ins a day`);
  const out = [];
  let previous = -1;
  const place = (hhmm, label) => {
    let m = minutesOf(timeOfDay(hhmm, label));
    while (m <= previous) m += 1440;
    previous = m;
    return m;
  };
  list.forEach((punch, index) => {
    if (!punch || typeof punch !== 'object') throw fail(400, 'Each clock-in needs a time');
    const inMin = place(punch.in, 'Clock in');
    const hasOut = punch.out !== null && punch.out !== undefined && punch.out !== '';
    if (!hasOut && index !== list.length - 1) throw fail(400, 'Only the last clock-in can be missing its clock-out');
    out.push({ inMin, outMin: hasOut ? place(punch.out, 'Clock out') : null });
  });
  if (previous - out[0].inMin > 24 * 60) throw fail(400, 'A day can span at most 24 hours');
  return out;
}

// ---- who clocked from where ----

function clientIp(req) {
  return normalizeIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
}

async function networkState(actor, ip) {
  const settings = (await query('SELECT network_only FROM attendance_settings WHERE id = 1')).rows[0];
  const enforced = Boolean(settings && settings.network_only);
  const networks = (await query('SELECT cidr FROM attendance_networks')).rows.map((r) => r.cidr);
  const exempt = Boolean(actor.remote_clock);
  return { enforced, exempt, ip, allowed: !enforced || exempt || ipAllowed(ip, networks) };
}

// The first device a person clocks from is trusted; any other is recorded as new and waits for HR to approve it.
async function registerDevice(userId, device) {
  if (!device.id) return;
  const known = (await query('SELECT COUNT(*)::int AS n FROM user_devices WHERE user_id = $1', [userId])).rows[0].n;
  await query(
    `INSERT INTO user_devices (user_id, device_id, name, trusted) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen = NOW(), name = COALESCE(NULLIF(EXCLUDED.name, ''), user_devices.name)`,
    [userId, device.id, device.name, known === 0]
  );
}

// ---- building days ----

// For these people over from..to: each day judged against their schedule, holidays, approved leave and level.
// Returns Map(userId -> { person, schedule, days: [evaluated day + punches], totals }). includeIp: show the addresses (HR only).
async function buildDays(userIds, from, to, { includeIp = false } = {}) {
  const today = await companyToday();
  const people = (await query(
    `SELECT u.id, u.username, u.first_name, u.middle_name, u.last_name, u.employee_no, u.department, u.job_level,
            to_char(u.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(u.separation_date, 'YYYY-MM-DD') AS separation_date,
            s.id AS schedule_id, s.name AS schedule_name, to_char(s.start_time, 'HH24:MI') AS start_text, to_char(s.end_time, 'HH24:MI') AS end_text,
            s.break_minutes, s.grace_minutes, s.overtime_min_minutes, s.work_days
     FROM users u
     JOIN work_schedules s ON s.id = COALESCE(u.schedule_id, (SELECT id FROM work_schedules WHERE is_default LIMIT 1))
     WHERE u.id = ANY($1::int[])`,
    [userIds]
  )).rows;

  const records = (await query(
    `SELECT r.id, r.user_id, to_char(r.work_date, 'YYYY-MM-DD') AS day, r.note, r.source
     FROM attendance_records r WHERE r.user_id = ANY($1::int[]) AND r.work_date BETWEEN $2::date AND $3::date`,
    [userIds, from, to]
  )).rows;
  const recordOf = new Map(records.map((r) => [`${r.user_id}|${r.day}`, r]));
  const punchRows = records.length ? (await query(
    `SELECT p.record_id, p.clock_in, p.clock_out, p.in_ip, p.out_ip, p.in_device, p.out_device,
            to_char(p.clock_in AT TIME ZONE $2, 'HH24:MI') AS in_text, to_char(p.clock_out AT TIME ZONE $2, 'HH24:MI') AS out_text,
            ((r.work_date + s.start_time) AT TIME ZONE $2) AS sched_start,
            ((r.work_date + s.end_time + CASE WHEN s.end_time > s.start_time THEN INTERVAL '0' ELSE INTERVAL '1 day' END) AT TIME ZONE $2) AS sched_end
     FROM attendance_punches p
     JOIN attendance_records r ON r.id = p.record_id
     JOIN users u ON u.id = r.user_id
     JOIN work_schedules s ON s.id = COALESCE(u.schedule_id, (SELECT id FROM work_schedules WHERE is_default LIMIT 1))
     WHERE p.record_id = ANY($1::int[]) ORDER BY p.clock_in`,
    [records.map((r) => r.id), TZ]
  )).rows : [];
  const punchesOf = new Map();
  for (const row of punchRows) {
    if (!punchesOf.has(row.record_id)) punchesOf.set(row.record_id, []);
    punchesOf.get(row.record_id).push(row);
  }
  const trusted = new Map((await query('SELECT user_id, device_id, trusted FROM user_devices WHERE user_id = ANY($1::int[])', [userIds])).rows
    .map((d) => [`${d.user_id}|${d.device_id}`, d.trusted]));

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
    const eligible = p.job_level !== 'managerial';
    const days = eachDay(from, to).map((date) => {
      if ((p.hire_date && date < p.hire_date) || (p.separation_date && date > p.separation_date)) {
        return {
          date, status: 'n/a', isWorkDay: false, isHoliday: false, leave: 0, lateMinutes: 0, undertimeMinutes: 0, workedMinutes: 0, overtimeMinutes: 0,
          afterHoursMinutes: 0, premiumMinutes: 0, overBreakMinutes: 0, absentDays: 0, overtimeEligible: eligible, punches: [], deviceFlag: false,
        };
      }
      const rec = recordOf.get(`${p.id}|${date}`);
      const rows = rec ? punchesOf.get(rec.id) || [] : [];
      const evaluated = evaluateDay({
        date, today, isHoliday: holidays.has(date), leave: Math.min(1, entry.all.get(date) || 0), overtimeEligible: eligible,
        punches: rows.map((r) => ({ clockIn: r.clock_in, clockOut: r.clock_out })),
        schedule: { ...base, start: rows.length ? rows[0].sched_start : null, end: rows.length ? rows[0].sched_end : null },
      });
      // a punch made by the person themselves from a device nobody approved (or none at all) is flagged for HR
      const flagged = (row) => rec && rec.source === 'self' && (!row.in_device || trusted.get(`${p.id}|${row.in_device}`) !== true
        || (row.out_device && trusted.get(`${p.id}|${row.out_device}`) !== true));
      const punches = rows.map((r) => ({
        in: r.in_text, out: r.out_text || null, flagged: Boolean(flagged(r)),
        ...(includeIp ? { inIp: r.in_ip, outIp: r.out_ip } : {}),
      }));
      return {
        ...evaluated, punches, deviceFlag: punches.some((x) => x.flagged),
        clockIn: punches.length ? punches[0].in : null,
        clockOut: punches.length && punches[punches.length - 1].out ? punches[punches.length - 1].out : null,
        note: rec ? rec.note : '', source: rec ? rec.source : null,
      };
    });
    out.set(p.id, {
      person: {
        id: p.id, username: p.username, firstName: p.first_name || '', middleName: p.middle_name || '', lastName: p.last_name || '',
        employeeNo: p.employee_no || '', department: p.department || '', jobLevel: p.job_level,
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

async function currentState(actor, req) {
  const today = await companyToday();
  const mine = (await buildDays([actor.id], today, today)).get(actor.id);
  // a stretch still open (maybe from before midnight, on a night shift)
  const open = (await query(
    `SELECT to_char(p.clock_in AT TIME ZONE $2, 'HH24:MI') AS in_text FROM attendance_punches p JOIN attendance_records r ON r.id = p.record_id
     WHERE r.user_id = $1 AND p.clock_out IS NULL AND p.clock_in > NOW() - ($3 || ' hours')::interval ORDER BY p.clock_in DESC LIMIT 1`,
    [actor.id, TZ, String(MAX_OPEN_HOURS)]
  )).rows[0];
  const network = await networkState(actor, clientIp(req));
  const pending = (await query(
    `SELECT COUNT(*)::int AS n FROM attendance_corrections c JOIN users u ON u.id = c.user_id
     WHERE c.status = 'pending' AND c.user_id <> $1 AND (u.manager_id = $1 OR $2::boolean)`,
    [actor.id, canManageEmployees(actor)]
  )).rows[0].n;
  return {
    today, timezone: TZ, schedule: mine ? mine.schedule : null, day: mine ? mine.days[0] : null,
    clockedIn: Boolean(open), openSince: open ? open.in_text : null,
    network: { enforced: network.enforced, exempt: network.exempt, allowed: network.allowed, ip: network.ip },
    isManager: (await query('SELECT 1 FROM users WHERE manager_id = $1 AND deactivated_at IS NULL LIMIT 1', [actor.id])).rows.length > 0,
    correctionsWaiting: pending,
  };
}

router.get('/today', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    res.json(await currentState(actor, req));
  } catch (err) {
    sendError(res, err, 'Attendance today error');
  }
});

// Both taps go through the same checks: office network (unless exempt), then the device is noted.
async function checkClockRules(req, actor) {
  const network = await networkState(actor, clientIp(req));
  if (!network.allowed) {
    throw Object.assign(fail(403, 'You can only clock in and out from the office network. If you work remotely, ask HR.'), { code: 'network' });
  }
  await registerDevice(actor.id, readDevice(req.headers));
}

router.post('/clock-in', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    await checkClockRules(req, actor);
    const today = await companyToday();
    const open = await query(
      `SELECT 1 FROM attendance_punches p JOIN attendance_records r ON r.id = p.record_id
       WHERE r.user_id = $1 AND p.clock_out IS NULL AND p.clock_in > NOW() - ($2 || ' hours')::interval LIMIT 1`,
      [actor.id, String(MAX_OPEN_HOURS)]
    );
    if (open.rows.length) throw fail(409, 'You are already clocked in. Clock out first.');
    const record = (await query(
      `INSERT INTO attendance_records (user_id, work_date, source) VALUES ($1, $2::date, 'self')
       ON CONFLICT (user_id, work_date) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING id`,
      [actor.id, today]
    )).rows[0];
    const count = (await query('SELECT COUNT(*)::int AS n FROM attendance_punches WHERE record_id = $1', [record.id])).rows[0].n;
    if (count >= MAX_PUNCHES) throw fail(400, `You can clock in at most ${MAX_PUNCHES} times a day`);
    await query('INSERT INTO attendance_punches (record_id, clock_in, in_ip, in_device) VALUES ($1, NOW(), $2, $3)', [record.id, clientIp(req), readDevice(req.headers).id]);
    res.status(201).json(await currentState(actor, req));
  } catch (err) {
    sendError(res, err, 'Clock in error');
  }
});

router.post('/clock-out', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    await checkClockRules(req, actor);
    const updated = await query(
      `UPDATE attendance_punches SET clock_out = NOW(), out_ip = $3, out_device = $4
       WHERE id = (SELECT p.id FROM attendance_punches p JOIN attendance_records r ON r.id = p.record_id
                   WHERE r.user_id = $1 AND p.clock_out IS NULL AND p.clock_in > NOW() - ($2 || ' hours')::interval ORDER BY p.clock_in DESC LIMIT 1)
       RETURNING id`,
      [actor.id, String(MAX_OPEN_HOURS), clientIp(req), readDevice(req.headers).id]
    );
    if (!updated.rows.length) throw fail(400, 'You are not clocked in');
    res.json(await currentState(actor, req));
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
    const result = (await buildDays([targetId], from, to, { includeIp: canManageEmployees(actor) })).get(targetId);
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
    const built = await buildDays(people, date, date, { includeIp: hr });
    const rows = Array.from(built.values()).map((b) => ({ ...b.person, ...b.days[0], schedule: b.schedule }))
      .filter((r) => r.status !== 'n/a')
      .sort((a, b) => (a.lastName || a.username).localeCompare(b.lastName || b.username));
    return res.json({ date, timezone: TZ, scope: hr ? 'all' : 'team', rows });
  } catch (err) {
    return sendError(res, err, 'Attendance board error');
  }
});

// ---- HR: fix a day ----

// Replace a day's punches (company time). Creates the day when it has none.
async function applyPunches({ userId, date, punches, source, note, editedBy }) {
  const record = (await query(
    `INSERT INTO attendance_records (user_id, work_date, source, note, edited_by) VALUES ($1, $2::date, $3, $4, $5)
     ON CONFLICT (user_id, work_date) DO UPDATE SET source = EXCLUDED.source, note = EXCLUDED.note, edited_by = EXCLUDED.edited_by
     RETURNING id`,
    [userId, date, source, note, editedBy]
  )).rows[0];
  await query('DELETE FROM attendance_punches WHERE record_id = $1', [record.id]);
  for (const p of punches) {
    await query(
      `INSERT INTO attendance_punches (record_id, clock_in, clock_out)
       VALUES ($1, ($2::date + ($3::int * INTERVAL '1 minute')) AT TIME ZONE $5, CASE WHEN $4::int IS NULL THEN NULL ELSE ($2::date + ($4::int * INTERVAL '1 minute')) AT TIME ZONE $5 END)`,
      [record.id, date, p.inMin, p.outMin, TZ]
    );
  }
}

// PUT /api/attendance/records - { userId, date, punches: [{ in: '08:00', out: '12:00' }, ...], note } (company time)
router.put('/records', async (req, res) => {
  try {
    const actor = await requireHr(req.user.userId);
    const body = req.body || {};
    const userId = parseId(body.userId);
    if (userId === null) throw fail(400, 'A valid person ID is required');
    if (!parseDay(body.date)) throw fail(400, 'Choose a real date');
    const list = body.punches !== undefined ? body.punches : [{ in: body.clockIn, out: body.clockOut }];
    const punches = cleanPunches(list);
    const note = text(body.note, 200, 'Note');
    if (!(await query("SELECT 1 FROM users WHERE id = $1 AND account_type = 'member'", [userId])).rows.length) throw fail(404, 'Person not found');
    await applyPunches({ userId, date: body.date, punches, source: 'hr', note, editedBy: actor.id });
    const row = (await buildDays([userId], body.date, body.date, { includeIp: true })).get(userId);
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

// ---- corrections: an employee asks, their manager or HR decides ----

const mapCorrection = (row) => ({
  id: row.id, userId: row.user_id, username: row.username, firstName: row.first_name || '', middleName: row.middle_name || '', lastName: row.last_name || '',
  date: row.day, punches: row.punches, reason: row.reason, status: row.status,
  decidedBy: row.decided_by_username || null, decidedAt: row.decided_at || null, decisionNote: row.decision_note || '', createdAt: row.created_at,
});
const CORRECTION_SELECT = `SELECT c.id, c.user_id, to_char(c.work_date, 'YYYY-MM-DD') AS day, c.punches, c.reason, c.status, c.decided_at, c.decision_note, c.created_at,
    u.username, u.first_name, u.middle_name, u.last_name, u.manager_id, d.username AS decided_by_username
  FROM attendance_corrections c JOIN users u ON u.id = c.user_id LEFT JOIN users d ON d.id = c.decided_by`;

function notify(req, userIds, payload) {
  for (const id of new Set(userIds)) req.io?.to(`user_${id}`).emit('attendance_updated', payload);
}

async function correctionApprovers(requester) {
  return (await query(
    `SELECT id FROM users WHERE account_type = 'member' AND deactivated_at IS NULL AND id <> $1 AND (id = $2 OR is_hr OR is_superadmin)`,
    [requester.id, requester.manager_id]
  )).rows.map((r) => r.id);
}

// POST /api/attendance/corrections - { date, punches: [{ in, out }], reason } for a day in the last 31 days
router.post('/corrections', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const body = req.body || {};
    const today = await companyToday();
    if (!parseDay(body.date)) throw fail(400, 'Choose a real date');
    if (body.date > today) throw fail(400, 'You cannot correct a day that has not happened');
    if ((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${body.date}T00:00:00Z`)) / DAY_MS > MAX_CORRECTION_DAYS) throw fail(400, `You can only correct the last ${MAX_CORRECTION_DAYS} days`);
    cleanPunches(body.punches); // validates
    const reason = text(body.reason, 300, 'Reason');
    if (!reason) throw fail(400, 'Say why the day needs correcting');
    const pending = await query("SELECT 1 FROM attendance_corrections WHERE user_id = $1 AND work_date = $2::date AND status = 'pending'", [actor.id, body.date]);
    if (pending.rows.length) throw fail(409, 'You already asked for a correction for that day');
    const created = await query(
      'INSERT INTO attendance_corrections (user_id, work_date, punches, reason) VALUES ($1, $2::date, $3::jsonb, $4) RETURNING id',
      [actor.id, body.date, JSON.stringify(body.punches.map((p) => ({ in: p.in, out: p.out || null }))), reason]
    );
    const row = (await query(`${CORRECTION_SELECT} WHERE c.id = $1`, [created.rows[0].id])).rows[0];
    const correction = mapCorrection(row);
    notify(req, await correctionApprovers(actor), { kind: 'requested', correction });
    res.status(201).json({ correction });
  } catch (err) {
    sendError(res, err, 'Create correction error');
  }
});

router.get('/corrections/mine', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const result = await query(`${CORRECTION_SELECT} WHERE c.user_id = $1 ORDER BY c.work_date DESC, c.id DESC LIMIT 50`, [actor.id]);
    res.json({ corrections: result.rows.map(mapCorrection) });
  } catch (err) {
    sendError(res, err, 'My corrections error');
  }
});

// GET /api/attendance/corrections/queue - waiting for me: my direct reports', or everyone's for HR
router.get('/corrections/queue', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const result = await query(
      `${CORRECTION_SELECT} WHERE c.status = 'pending' AND c.user_id <> $1 AND (u.manager_id = $1 OR $2::boolean) ORDER BY c.work_date, c.id`,
      [actor.id, canManageEmployees(actor)]
    );
    res.json({ corrections: result.rows.map(mapCorrection) });
  } catch (err) {
    sendError(res, err, 'Corrections queue error');
  }
});

router.put('/corrections/:id/decision', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid correction ID is required');
    const status = req.body && req.body.status;
    if (!['approved', 'rejected'].includes(status)) throw fail(400, 'status must be approved or rejected');
    const note = text(req.body.note, 300, 'Note');
    const found = (await query(`${CORRECTION_SELECT} WHERE c.id = $1`, [id])).rows[0];
    if (!found) throw fail(404, 'Correction not found');
    if (found.user_id === actor.id) throw fail(403, 'You cannot decide your own correction');
    if (!(found.manager_id === actor.id || canManageEmployees(actor))) throw fail(403, 'Only their manager or HR can decide this');
    if (found.status !== 'pending') throw fail(409, 'This correction was already decided or cancelled');
    if (status === 'approved') {
      await applyPunches({
        userId: found.user_id, date: found.day, punches: cleanPunches(found.punches), source: 'correction',
        note: `Correction: ${found.reason}`.slice(0, 200), editedBy: actor.id,
      });
    }
    await query('UPDATE attendance_corrections SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3 WHERE id = $4', [status, actor.id, note, id]);
    const correction = mapCorrection((await query(`${CORRECTION_SELECT} WHERE c.id = $1`, [id])).rows[0]);
    notify(req, [found.user_id, ...(await correctionApprovers({ id: found.user_id, manager_id: found.manager_id }))], { kind: status, correction });
    res.json({ correction });
  } catch (err) {
    sendError(res, err, 'Decide correction error');
  }
});

router.post('/corrections/:id/cancel', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid correction ID is required');
    const result = await query("UPDATE attendance_corrections SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id", [id, actor.id]);
    if (!result.rows.length) throw fail(404, 'No pending correction to cancel');
    res.json({ id });
  } catch (err) {
    sendError(res, err, 'Cancel correction error');
  }
});

// ---- office networks ----

// GET /api/attendance/networks (HR) - the rule, the allowed networks, and the address this request came from
router.get('/networks', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const enforced = Boolean((await query('SELECT network_only FROM attendance_settings WHERE id = 1')).rows[0].network_only);
    const networks = (await query('SELECT id, label, cidr FROM attendance_networks ORDER BY LOWER(label), id')).rows;
    res.json({ enforced, networks, myIp: clientIp(req), myIpAllowed: ipAllowed(clientIp(req), networks.map((n) => n.cidr)) });
  } catch (err) {
    sendError(res, err, 'List networks error');
  }
});

router.post('/networks', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const label = text(req.body && req.body.label, 80, 'Label');
    if (!label) throw fail(400, 'Name the place, for example Main office');
    const network = parseNetwork(req.body && req.body.cidr);
    if (!network) throw fail(400, 'Enter an IP address (203.0.113.7) or a network (192.168.10.0/24)');
    const cidr = network.prefix === null ? network.address : `${network.address}/${network.prefix}`;
    if ((await query('SELECT COUNT(*)::int AS n FROM attendance_networks')).rows[0].n >= MAX_NETWORKS) throw fail(400, `At most ${MAX_NETWORKS} networks`);
    if ((await query('SELECT 1 FROM attendance_networks WHERE cidr = $1', [cidr])).rows.length) throw fail(409, 'That address is already listed');
    const created = (await query('INSERT INTO attendance_networks (label, cidr) VALUES ($1, $2) RETURNING id, label, cidr', [label, cidr])).rows[0];
    res.status(201).json({ network: created });
  } catch (err) {
    sendError(res, err, 'Add network error');
  }
});

router.delete('/networks/:id', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid network ID is required');
    const enforced = (await query('SELECT network_only FROM attendance_settings WHERE id = 1')).rows[0].network_only;
    const count = (await query('SELECT COUNT(*)::int AS n FROM attendance_networks')).rows[0].n;
    if (enforced && count <= 1) throw fail(400, 'Switch the office-network rule off before removing the last network');
    const result = await query('DELETE FROM attendance_networks WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) throw fail(404, 'Network not found');
    res.json({ id });
  } catch (err) {
    sendError(res, err, 'Remove network error');
  }
});

// PUT /api/attendance/network-policy - { enforced }: when on, people clock in and out only from a listed network
router.put('/network-policy', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    if (typeof (req.body && req.body.enforced) !== 'boolean') throw fail(400, 'enforced must be true or false');
    if (req.body.enforced && !(await query('SELECT 1 FROM attendance_networks LIMIT 1')).rows.length) throw fail(400, 'Add at least one office network first');
    await query('UPDATE attendance_settings SET network_only = $1 WHERE id = 1', [req.body.enforced]);
    res.json({ enforced: req.body.enforced });
  } catch (err) {
    sendError(res, err, 'Set network policy error');
  }
});

// ---- devices ----

const mapDevice = (row) => ({
  id: row.id, userId: row.user_id, username: row.username, firstName: row.first_name || '', middleName: row.middle_name || '', lastName: row.last_name || '',
  name: row.name || 'Unnamed device', trusted: row.trusted, firstSeen: row.first_seen, lastSeen: row.last_seen, punches: row.punches,
});
const DEVICE_SELECT = `SELECT d.id, d.user_id, d.name, d.trusted, d.first_seen, d.last_seen, u.username, u.first_name, u.middle_name, u.last_name,
    (SELECT COUNT(*)::int FROM attendance_punches p JOIN attendance_records r ON r.id = p.record_id WHERE r.user_id = d.user_id AND (p.in_device = d.device_id OR p.out_device = d.device_id)) AS punches
  FROM user_devices d JOIN users u ON u.id = d.user_id`;

// GET /api/attendance/devices/pending - devices people clocked in from that nobody approved yet
router.get('/devices/pending', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const result = await query(`${DEVICE_SELECT} WHERE NOT d.trusted AND u.deactivated_at IS NULL ORDER BY d.last_seen DESC`);
    res.json({ devices: result.rows.map(mapDevice) });
  } catch (err) {
    sendError(res, err, 'Pending devices error');
  }
});

router.get('/devices', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const userId = parseId(req.query.userId);
    if (userId === null) throw fail(400, 'A valid person ID is required');
    const result = await query(`${DEVICE_SELECT} WHERE d.user_id = $1 ORDER BY d.first_seen`, [userId]);
    res.json({ devices: result.rows.map(mapDevice) });
  } catch (err) {
    sendError(res, err, 'List devices error');
  }
});

// PUT /api/attendance/devices/:id - { trusted }: approve a new phone or computer (clears its flags), or stop trusting it
router.put('/devices/:id', async (req, res) => {
  try {
    const actor = await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid device ID is required');
    if (typeof (req.body && req.body.trusted) !== 'boolean') throw fail(400, 'trusted must be true or false');
    const result = await query('UPDATE user_devices SET trusted = $1, trusted_by = CASE WHEN $1 THEN $2::int ELSE NULL END WHERE id = $3 RETURNING id', [req.body.trusted, actor.id, id]);
    if (!result.rows.length) throw fail(404, 'Device not found');
    res.json({ device: mapDevice((await query(`${DEVICE_SELECT} WHERE d.id = $1`, [id])).rows[0]) });
  } catch (err) {
    sendError(res, err, 'Trust device error');
  }
});

// DELETE /api/attendance/devices/:id - forget a device (a lost phone). If it was their only device, the next one they use is trusted.
router.delete('/devices/:id', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid device ID is required');
    const result = await query('DELETE FROM user_devices WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) throw fail(404, 'Device not found');
    res.json({ id });
  } catch (err) {
    sendError(res, err, 'Forget device error');
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
const punchText = (d) => d.punches.map((x) => `${x.in}-${x.out || '?'}`).join('; ');

// GET /api/attendance/export?from=&to=&detail=1 - one row per employee for the period (or one per day with detail=1).
// Everything payroll needs to count: days, absences, leave (paid and unpaid), holidays, late, break, undertime, hours.
// Managerial staff show no overtime and no rest-day/holiday premium hours (their hours are still counted).
router.get('/export', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const { from, to } = rangeFrom(req.query);
    const people = (await query(
      `SELECT id FROM users WHERE account_type = 'member' AND (deactivated_at IS NULL OR deactivated_at >= $1::date)`, [from]
    )).rows.map((r) => r.id);
    const built = people.length ? await buildDays(people, from, to) : new Map();
    const list = Array.from(built.values()).sort((a, b) => (a.person.lastName || a.person.username).localeCompare(b.person.lastName || b.person.username));
    const level = (b) => (b.person.jobLevel === 'managerial' ? 'Managerial' : 'Rank and file');
    const lines = [];
    if (req.query.detail === '1') {
      lines.push(['Employee no.', 'Name', 'Department', 'Level', 'Date', 'Status', 'Clock-ins and outs', 'Late (min)', 'Over break (min)', 'Undertime (min)', 'Hours worked',
        'Overtime (min)', 'After-hours, not overtime (min)', 'Rest day / holiday hours', 'Leave days', 'Note'].join(','));
      for (const b of list) {
        for (const d of b.days.filter((x) => x.status !== 'n/a')) {
          lines.push([b.person.employeeNo, fullName(b.person), b.person.department, level(b), d.date, d.status, punchText(d), d.lateMinutes, d.overBreakMinutes, d.undertimeMinutes,
            round2(d.workedMinutes / 60), d.overtimeMinutes, d.afterHoursMinutes, round2(d.premiumMinutes / 60), d.leave, d.note].map(csvCell).join(','));
        }
      }
    } else {
      lines.push(['Employee no.', 'Name', 'Department', 'Level', 'Overtime eligible', 'Period from', 'Period to', 'Scheduled days', 'Days present', 'Days absent', 'Paid leave days',
        'Unpaid leave days', 'Holidays', 'Late (min)', 'Times late', 'Over break (min)', 'Undertime (min)', 'Hours worked', 'Overtime (hours)',
        'After-hours, not overtime (hours)', 'Rest day / holiday hours', 'Days without clock-out'].join(','));
      for (const b of list) {
        const t = b.totals;
        lines.push([b.person.employeeNo, fullName(b.person), b.person.department, level(b), b.person.jobLevel === 'managerial' ? 'no' : 'yes', from, to, t.scheduledDays, t.presentDays,
          t.absentDays, t.paidLeaveDays, t.unpaidLeaveDays, t.holidays, t.lateMinutes, t.lateCount, t.overBreakMinutes, t.undertimeMinutes, t.workedHours, t.overtimeHours,
          round2(t.afterHoursMinutes / 60), t.premiumHours, t.incompleteDays].map(csvCell).join(','));
      }
    }
    res.json({ csv: `${lines.join('\r\n')}\r\n`, count: list.length, from, to });
  } catch (err) {
    sendError(res, err, 'Export attendance error');
  }
});

module.exports = router;
