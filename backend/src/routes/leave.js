// Leave: types and balances, requests, approval by the manager (or HR), a team calendar, company holidays.
//
// A request uses working days (Monday to Friday, minus company holidays), or 0.5 for a half day. It waits for
// the requester's manager, or any HR / Superadmin who is not the requester. Balances are per calendar year:
// the leave type's days per year plus any adjustment HR made for that person; approved and pending days
// count against it. A request counts toward the year it starts in. Nothing accrues or carries over.
const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { fail, canManageEmployees, requireHr } = require('../hr');
const { parseDay, formatDay, leaveDays } = require('../leaveDays');

const router = express.Router();
router.use(authenticateToken);

const MAX_RANGE_DAYS = 90;
const MAX_BACKDATE_DAYS = 60;
const MAX_AHEAD_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

const parseId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

function text(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw fail(400, `${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw fail(400, `${label} can be at most ${max} characters`);
  return trimmed;
}

const today = () => new Date().toISOString().slice(0, 10);
const num = (value) => Number(value || 0);

// The signed-in person, who must be an active member.
async function member(userId) {
  const row = (await query(
    'SELECT id, username, account_type, is_superadmin, is_hr, manager_id, deactivated_at FROM users WHERE id = $1', [userId]
  )).rows[0];
  if (!row) throw fail(401, 'Account not found');
  if (row.account_type !== 'member' || row.deactivated_at) throw fail(403, 'Leave is for workspace members');
  return row;
}

const isHrLike = (actor) => canManageEmployees(actor);

async function holidaySet(from, to) {
  const rows = (await query("SELECT to_char(day, 'YYYY-MM-DD') AS day FROM company_holidays WHERE day BETWEEN $1 AND $2", [from, to])).rows;
  return new Set(rows.map((r) => r.day));
}

// ---- leave types ----

const mapType = (row) => ({ id: row.id, name: row.name, daysPerYear: num(row.days_per_year), paid: row.paid, active: row.active });

router.get('/types', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const result = await query(`SELECT id, name, days_per_year, paid, active FROM leave_types ${isHrLike(actor) ? '' : 'WHERE active'} ORDER BY position, id`);
    res.json({ types: result.rows.map(mapType) });
  } catch (err) {
    sendError(res, err, 'List leave types error');
  }
});

function cleanType(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = text(body.name, 60, 'Name');
    if (!out.name) throw fail(400, 'A leave type needs a name');
  }
  if (!partial || body.daysPerYear !== undefined) {
    const days = body.daysPerYear === undefined ? 0 : Number(body.daysPerYear);
    if (!Number.isFinite(days) || days < 0 || days > 365 || Math.round(days * 2) !== days * 2) throw fail(400, 'Days per year must be from 0 to 365, in halves');
    out.daysPerYear = days;
  }
  if (body.paid !== undefined) {
    if (typeof body.paid !== 'boolean') throw fail(400, 'paid must be true or false');
    out.paid = body.paid;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw fail(400, 'active must be true or false');
    out.active = body.active;
  }
  return out;
}

router.post('/types', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const t = cleanType(req.body || {}, { partial: false });
    if ((await query('SELECT 1 FROM leave_types WHERE LOWER(name) = LOWER($1)', [t.name])).rows.length) throw fail(409, 'There is already a leave type with that name');
    const row = (await query(
      `INSERT INTO leave_types (name, days_per_year, paid, position)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM leave_types), 1)) RETURNING id, name, days_per_year, paid, active`,
      [t.name, t.daysPerYear, t.paid === undefined ? true : t.paid]
    )).rows[0];
    res.status(201).json({ type: mapType(row) });
  } catch (err) {
    sendError(res, err, 'Create leave type error');
  }
});

router.put('/types/:id', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid leave type ID is required');
    const t = cleanType(req.body || {}, { partial: true });
    if (t.name && (await query('SELECT 1 FROM leave_types WHERE LOWER(name) = LOWER($1) AND id <> $2', [t.name, id])).rows.length) throw fail(409, 'There is already a leave type with that name');
    const row = (await query(
      `UPDATE leave_types SET name = COALESCE($1, name), days_per_year = COALESCE($2, days_per_year),
              paid = COALESCE($3, paid), active = COALESCE($4, active)
       WHERE id = $5 RETURNING id, name, days_per_year, paid, active`,
      [t.name ?? null, t.daysPerYear ?? null, t.paid ?? null, t.active ?? null, id]
    )).rows[0];
    if (!row) throw fail(404, 'Leave type not found');
    res.json({ type: mapType(row) });
  } catch (err) {
    sendError(res, err, 'Update leave type error');
  }
});

// A type that has requests is only hidden (inactive), so their history stays readable.
router.delete('/types/:id', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid leave type ID is required');
    const used = await query('SELECT 1 FROM leave_requests WHERE leave_type_id = $1 LIMIT 1', [id]);
    if (used.rows.length) {
      const hidden = await query('UPDATE leave_types SET active = false WHERE id = $1 RETURNING id', [id]);
      if (!hidden.rows.length) throw fail(404, 'Leave type not found');
      return res.json({ id, hidden: true });
    }
    const removed = await query('DELETE FROM leave_types WHERE id = $1 RETURNING id', [id]);
    if (!removed.rows.length) throw fail(404, 'Leave type not found');
    return res.json({ id, hidden: false });
  } catch (err) {
    return sendError(res, err, 'Delete leave type error');
  }
});

// ---- balances ----

async function balancesFor(userId, year) {
  const rows = (await query(
    `SELECT t.id, t.name, t.days_per_year, t.paid, COALESCE(e.adjustment, 0) AS adjustment,
            COALESCE(SUM(r.days) FILTER (WHERE r.status = 'approved'), 0) AS used,
            COALESCE(SUM(r.days) FILTER (WHERE r.status = 'pending'), 0) AS pending
     FROM leave_types t
     LEFT JOIN leave_entitlements e ON e.leave_type_id = t.id AND e.user_id = $1 AND e.year = $2
     LEFT JOIN leave_requests r ON r.leave_type_id = t.id AND r.user_id = $1
          AND EXTRACT(YEAR FROM r.start_date) = $2 AND r.status IN ('approved', 'pending')
     WHERE t.active
     GROUP BY t.id, e.adjustment
     ORDER BY t.position, t.id`,
    [userId, year]
  )).rows;
  return rows.map((row) => {
    const capped = num(row.days_per_year) > 0;
    const entitled = num(row.days_per_year) + num(row.adjustment);
    return {
      typeId: row.id, name: row.name, paid: row.paid, capped, entitled, adjustment: num(row.adjustment),
      used: num(row.used), pending: num(row.pending), remaining: capped ? entitled - num(row.used) - num(row.pending) : null,
    };
  });
}

function yearFrom(value) {
  const year = value === undefined ? new Date().getUTCFullYear() : Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw fail(400, 'year must be a four-digit year');
  return year;
}

// ---- requests ----

const REQUEST_SELECT = `
  SELECT r.id, r.user_id, r.leave_type_id, to_char(r.start_date, 'YYYY-MM-DD') AS start_date, to_char(r.end_date, 'YYYY-MM-DD') AS end_date,
         r.days, r.half_day, r.reason, r.status, r.decided_at, r.decision_note, r.created_at,
         t.name AS type_name, u.username, u.first_name, u.last_name, u.middle_name, u.manager_id, u.employee_no, u.department,
         d.username AS decided_by_username
  FROM leave_requests r
  JOIN leave_types t ON t.id = r.leave_type_id
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users d ON d.id = r.decided_by`;

function mapRequest(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    employeeNo: row.employee_no || '',
    department: row.department || '',
    firstName: row.first_name || '',
    middleName: row.middle_name || '',
    lastName: row.last_name || '',
    typeId: row.leave_type_id,
    typeName: row.type_name,
    startDate: row.start_date,
    endDate: row.end_date,
    days: num(row.days),
    halfDay: row.half_day,
    reason: row.reason || '',
    status: row.status,
    decidedBy: row.decided_by_username || null,
    decidedAt: row.decided_at || null,
    decisionNote: row.decision_note || '',
    createdAt: row.created_at,
  };
}

// Who is told about a new request, and who may decide it: the manager, and HR / Superadmin (never the requester).
async function approverIds(requester) {
  const result = await query(
    `SELECT id FROM users WHERE account_type = 'member' AND deactivated_at IS NULL AND id <> $1
       AND (id = $2 OR is_hr OR is_superadmin)`,
    [requester.id, requester.manager_id]
  );
  return result.rows.map((r) => r.id);
}

function notify(req, userIds, payload) {
  for (const id of new Set(userIds)) req.io?.to(`user_${id}`).emit('leave_updated', payload);
}

// GET /api/leave/me?year= - my balances, my requests, the holidays (so the form can count days)
router.get('/me', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const year = yearFrom(req.query.year);
    const [balances, requests, holidays, pending] = await Promise.all([
      balancesFor(actor.id, year),
      query(`${REQUEST_SELECT} WHERE r.user_id = $1 ORDER BY r.start_date DESC, r.id DESC LIMIT 200`, [actor.id]),
      query("SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM company_holidays WHERE day >= $1::date - INTERVAL '1 year' ORDER BY day", [`${year}-01-01`]),
      query(
        `SELECT COUNT(*)::int AS n FROM leave_requests r JOIN users u ON u.id = r.user_id
         WHERE r.status = 'pending' AND r.user_id <> $1 AND (u.manager_id = $1 OR $2::boolean)`,
        [actor.id, isHrLike(actor)]
      ),
    ]);
    res.json({
      year, balances, requests: requests.rows.map(mapRequest), holidays: holidays.rows,
      approvalsWaiting: pending.rows[0].n, canManage: isHrLike(actor), hasManager: Boolean(actor.manager_id),
    });
  } catch (err) {
    sendError(res, err, 'My leave error');
  }
});

// POST /api/leave/requests
router.post('/requests', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const body = req.body || {};
    const typeId = parseId(body.typeId);
    const type = typeId ? (await query('SELECT id, name, days_per_year FROM leave_types WHERE id = $1 AND active', [typeId])).rows[0] : null;
    if (!type) throw fail(404, 'That leave type was not found');
    const start = parseDay(body.startDate);
    const end = parseDay(body.endDate === undefined || body.endDate === '' ? body.startDate : body.endDate);
    if (!start || !end) throw fail(400, 'Choose real start and end dates');
    if (end < start) throw fail(400, 'The last day is before the first day');
    const startKey = formatDay(start);
    const endKey = formatDay(end);
    const now = Date.parse(`${today()}T00:00:00Z`);
    if (start.getTime() < now - MAX_BACKDATE_DAYS * DAY_MS) throw fail(400, `Leave cannot start more than ${MAX_BACKDATE_DAYS} days ago`);
    if (end.getTime() > now + MAX_AHEAD_DAYS * DAY_MS) throw fail(400, 'That is too far ahead');
    if ((end.getTime() - start.getTime()) / DAY_MS + 1 > MAX_RANGE_DAYS) throw fail(400, `A request can cover at most ${MAX_RANGE_DAYS} days; split longer leave`);
    const halfDay = body.halfDay === true;
    if (body.halfDay !== undefined && typeof body.halfDay !== 'boolean') throw fail(400, 'halfDay must be true or false');
    if (halfDay && startKey !== endKey) throw fail(400, 'A half day is a single day');
    const reason = text(body.reason, 500, 'Reason');

    const days = leaveDays(startKey, endKey, { halfDay, holidays: await holidaySet(startKey, endKey) });
    if (days <= 0) throw fail(400, halfDay ? 'A half day must be on a working day' : 'That range has no working days (weekends and holidays are not counted)');

    const clash = await query(
      "SELECT 1 FROM leave_requests WHERE user_id = $1 AND status IN ('pending', 'approved') AND start_date <= $3::date AND end_date >= $2::date LIMIT 1",
      [actor.id, startKey, endKey]
    );
    if (clash.rows.length) throw fail(409, 'You already have leave on some of those days');

    if (Number(type.days_per_year) > 0) {
      const balance = (await balancesFor(actor.id, start.getUTCFullYear())).find((b) => b.typeId === type.id);
      if (balance && balance.remaining < days) throw fail(400, `Not enough ${type.name} left (${balance.remaining} day${balance.remaining === 1 ? '' : 's'} remaining, this needs ${days})`);
    }

    const created = await query(
      `INSERT INTO leave_requests (user_id, leave_type_id, start_date, end_date, days, half_day, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [actor.id, type.id, startKey, endKey, days, halfDay, reason]
    );
    const row = (await query(`${REQUEST_SELECT} WHERE r.id = $1`, [created.rows[0].id])).rows[0];
    const request = mapRequest(row);
    notify(req, await approverIds(actor), { kind: 'requested', request });
    res.status(201).json({ request });
  } catch (err) {
    sendError(res, err, 'Create leave request error');
  }
});

// POST /api/leave/requests/:id/cancel - mine, while pending or approved and not yet over
router.post('/requests/:id/cancel', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid request ID is required');
    const found = (await query('SELECT id, user_id, status, to_char(end_date, \'YYYY-MM-DD\') AS end_date FROM leave_requests WHERE id = $1', [id])).rows[0];
    if (!found || found.user_id !== actor.id) throw fail(404, 'Request not found');
    if (found.status === 'pending' || (found.status === 'approved' && found.end_date >= today())) {
      await query("UPDATE leave_requests SET status = 'cancelled' WHERE id = $1", [id]);
    } else {
      throw fail(400, 'This request can no longer be cancelled');
    }
    const request = mapRequest((await query(`${REQUEST_SELECT} WHERE r.id = $1`, [id])).rows[0]);
    notify(req, await approverIds(actor), { kind: 'cancelled', request });
    res.json({ request });
  } catch (err) {
    sendError(res, err, 'Cancel leave request error');
  }
});

// GET /api/leave/approvals - waiting for me: my direct reports', or everyone's when I am HR / Superadmin
router.get('/approvals', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const result = await query(
      `${REQUEST_SELECT} WHERE r.status = 'pending' AND r.user_id <> $1 AND (u.manager_id = $1 OR $2::boolean)
       ORDER BY r.start_date, r.id`,
      [actor.id, isHrLike(actor)]
    );
    res.json({ requests: result.rows.map(mapRequest) });
  } catch (err) {
    sendError(res, err, 'List approvals error');
  }
});

// PUT /api/leave/requests/:id/decision - { status: 'approved' | 'rejected', note? }
router.put('/requests/:id/decision', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid request ID is required');
    const status = req.body && req.body.status;
    if (!['approved', 'rejected'].includes(status)) throw fail(400, 'status must be approved or rejected');
    const note = text(req.body.note, 300, 'Note');
    const found = (await query(
      'SELECT r.id, r.user_id, r.status, u.manager_id FROM leave_requests r JOIN users u ON u.id = r.user_id WHERE r.id = $1', [id]
    )).rows[0];
    if (!found) throw fail(404, 'Request not found');
    if (found.user_id === actor.id) throw fail(403, 'You cannot decide your own request');
    if (!(found.manager_id === actor.id || isHrLike(actor))) throw fail(403, 'Only their manager or HR can decide this request');
    if (found.status !== 'pending') throw fail(409, 'This request was already decided or cancelled');
    await query('UPDATE leave_requests SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3 WHERE id = $4', [status, actor.id, note, id]);
    const request = mapRequest((await query(`${REQUEST_SELECT} WHERE r.id = $1`, [id])).rows[0]);
    const requester = { id: found.user_id, manager_id: found.manager_id };
    notify(req, [found.user_id, ...(await approverIds(requester))], { kind: status, request });
    res.json({ request });
  } catch (err) {
    sendError(res, err, 'Decide leave request error');
  }
});

// ---- HR: every leave record ----

const RECORD_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

// The filtered records for HR: ?status=&typeId=&userId=&q=&from=&to= (leave overlapping from..to)
async function recordsFor(params, limit) {
  const where = [];
  const values = [];
  const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
  if (params.status) {
    if (!RECORD_STATUSES.includes(params.status)) throw fail(400, 'Unknown status');
    add('r.status = ?', params.status);
  }
  if (params.typeId) {
    const id = parseId(params.typeId);
    if (id === null) throw fail(400, 'A valid leave type ID is required');
    add('r.leave_type_id = ?', id);
  }
  if (params.userId) {
    const id = parseId(params.userId);
    if (id === null) throw fail(400, 'A valid person ID is required');
    add('r.user_id = ?', id);
  }
  if (params.from) {
    if (!parseDay(params.from)) throw fail(400, 'from must be a date');
    add('r.end_date >= ?::date', params.from);
  }
  if (params.to) {
    if (!parseDay(params.to)) throw fail(400, 'to must be a date');
    add('r.start_date <= ?::date', params.to);
  }
  if (typeof params.q === 'string' && params.q.trim()) {
    const escaped = params.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    values.push(`%${escaped}%`);
    const n = values.length; // the one search text is used three times
    where.push(`(u.username ILIKE $${n} ESCAPE '\\' OR COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '') ILIKE $${n} ESCAPE '\\' OR COALESCE(u.employee_no, '') ILIKE $${n} ESCAPE '\\')`);
  }
  const rows = (await query(
    `${REQUEST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.start_date DESC, r.id DESC LIMIT ${limit + 1}`, values
  )).rows;
  return { requests: rows.slice(0, limit).map(mapRequest), truncated: rows.length > limit };
}

router.get('/records', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    res.json(await recordsFor(req.query, 500));
  } catch (err) {
    sendError(res, err, 'Leave records error');
  }
});

// A CSV cell: quoted when needed; one that could start a formula is defused.
function csvCell(value) {
  let cell = value === null || value === undefined ? '' : String(value);
  if (/^[=@\t\r]/.test(cell) || (/^[+-]/.test(cell) && !/^[+-][\d\s().-]+$/.test(cell))) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

const dayOf = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

// GET /api/leave/records/export - the same filters as a CSV
router.get('/records/export', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const { requests, truncated } = await recordsFor(req.query, 5000);
    const header = ['Employee no.', 'Name', 'Department', 'Leave type', 'From', 'To', 'Days', 'Half day', 'Status', 'Reason', 'Decided by', 'Decided on', 'Decision note', 'Requested on'];
    const lines = [header.join(',')].concat(requests.map((r) => [
      r.employeeNo, [r.firstName, r.middleName, r.lastName].filter(Boolean).join(' ') || r.username, r.department, r.typeName, r.startDate, r.endDate, r.days,
      r.halfDay ? 'yes' : '', r.status, r.reason, r.decidedBy || '', dayOf(r.decidedAt), r.decisionNote, dayOf(r.createdAt),
    ].map(csvCell).join(',')));
    res.json({ csv: `${lines.join('\r\n')}\r\n`, count: requests.length, truncated });
  } catch (err) {
    sendError(res, err, 'Export leave records error');
  }
});

// ---- calendar ----

// GET /api/leave/calendar?month=YYYY-MM&scope=team|all - who is away. The team is me, my manager, the people
// who share my manager, and my direct reports. HR and the Superadmin may ask for everyone.
router.get('/calendar', async (req, res) => {
  try {
    const actor = await member(req.user.userId);
    const month = typeof req.query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : today().slice(0, 7);
    const first = `${month}-01`;
    const lastDate = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
    const last = formatDay(lastDate);
    const everyone = req.query.scope === 'all' && isHrLike(actor);
    const result = await query(
      `${REQUEST_SELECT}
       WHERE r.status IN ('approved', 'pending') AND r.start_date <= $2::date AND r.end_date >= $1::date
         AND u.account_type = 'member' AND u.deactivated_at IS NULL
         AND ($3::boolean OR u.id = $4 OR u.id = $5 OR u.manager_id = $4
              OR ($5::int IS NOT NULL AND u.manager_id = $5))
       ORDER BY r.start_date, u.username`,
      [first, last, everyone, actor.id, actor.manager_id]
    );
    const holidays = await query("SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM company_holidays WHERE day BETWEEN $1 AND $2 ORDER BY day", [first, last]);
    res.json({ month, scope: everyone ? 'all' : 'team', requests: result.rows.map(mapRequest), holidays: holidays.rows });
  } catch (err) {
    sendError(res, err, 'Leave calendar error');
  }
});

// ---- HR: holidays, everyone's balances, adjustments ----

router.get('/holidays', async (req, res) => {
  try {
    await member(req.user.userId);
    const year = yearFrom(req.query.year);
    const result = await query("SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM company_holidays WHERE EXTRACT(YEAR FROM day) = $1 ORDER BY day", [year]);
    res.json({ year, holidays: result.rows });
  } catch (err) {
    sendError(res, err, 'List holidays error');
  }
});

router.post('/holidays', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const day = parseDay(req.body && req.body.day);
    if (!day) throw fail(400, 'Choose a real date');
    const name = text(req.body.name, 100, 'Name');
    if (!name) throw fail(400, 'A holiday needs a name');
    await query('INSERT INTO company_holidays (day, name) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET name = EXCLUDED.name', [formatDay(day), name]);
    res.status(201).json({ day: formatDay(day), name });
  } catch (err) {
    sendError(res, err, 'Add holiday error');
  }
});

router.delete('/holidays/:day', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const day = parseDay(req.params.day);
    if (!day) throw fail(400, 'A date is required');
    const result = await query('DELETE FROM company_holidays WHERE day = $1 RETURNING day', [formatDay(day)]);
    if (!result.rows.length) throw fail(404, 'Holiday not found');
    res.json({ day: formatDay(day) });
  } catch (err) {
    sendError(res, err, 'Delete holiday error');
  }
});

// GET /api/leave/balances/:userId?year= - one person's balances (HR)
router.get('/balances/:userId', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const userId = parseId(req.params.userId);
    if (userId === null) throw fail(400, 'A valid person ID is required');
    const year = yearFrom(req.query.year);
    const person = (await query("SELECT id FROM users WHERE id = $1 AND account_type = 'member'", [userId])).rows[0];
    if (!person) throw fail(404, 'Person not found');
    res.json({ year, balances: await balancesFor(userId, year) });
  } catch (err) {
    sendError(res, err, 'Balances error');
  }
});

// PUT /api/leave/entitlements - { userId, typeId, year, adjustment } extra (or fewer) days for one person in one year
router.put('/entitlements', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const body = req.body || {};
    const userId = parseId(body.userId);
    const typeId = parseId(body.typeId);
    const year = yearFrom(body.year);
    const adjustment = Number(body.adjustment);
    if (userId === null || typeId === null) throw fail(400, 'userId and typeId are required');
    if (!Number.isFinite(adjustment) || Math.abs(adjustment) > 365 || Math.round(adjustment * 2) !== adjustment * 2) throw fail(400, 'The adjustment must be a number of days in halves, from -365 to 365');
    if (!(await query("SELECT 1 FROM users WHERE id = $1 AND account_type = 'member'", [userId])).rows.length) throw fail(404, 'Person not found');
    if (!(await query('SELECT 1 FROM leave_types WHERE id = $1', [typeId])).rows.length) throw fail(404, 'Leave type not found');
    await query(
      `INSERT INTO leave_entitlements (user_id, leave_type_id, year, adjustment) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, leave_type_id, year) DO UPDATE SET adjustment = EXCLUDED.adjustment`,
      [userId, typeId, year, adjustment]
    );
    res.json({ balances: await balancesFor(userId, year) });
  } catch (err) {
    sendError(res, err, 'Set entitlement error');
  }
});

module.exports = router;
