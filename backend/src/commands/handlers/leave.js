const { query } = require('../../db');

const number = (value) => Number(value || 0);

function parseYear(value) {
  if (value === undefined) return new Date().getUTCFullYear();
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw Object.assign(new Error('Use a four-digit year from 2000 to 2100'), { status: 400 });
  }
  return year;
}

async function leaveData(userId, year) {
  const [balances, requests] = await Promise.all([
    query(
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
    ),
    query(
      `SELECT r.id, to_char(r.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(r.end_date, 'YYYY-MM-DD') AS end_date, r.days, r.half_day,
              r.status, r.created_at, t.id AS type_id, t.name AS type_name
       FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
       WHERE r.user_id = $1 AND EXTRACT(YEAR FROM r.start_date) = $2
       ORDER BY r.start_date DESC, r.id DESC LIMIT 200`,
      [userId, year]
    ),
  ]);
  return {
    balances: balances.rows.map((row) => {
      const capped = number(row.days_per_year) > 0;
      const entitled = number(row.days_per_year) + number(row.adjustment);
      const used = number(row.used);
      const pending = number(row.pending);
      return {
        typeId: row.id, name: row.name, paid: row.paid, capped, entitled,
        adjustment: number(row.adjustment), used, pending,
        remaining: capped ? entitled - used - pending : null,
      };
    }),
    requests: requests.rows.map((row) => ({
      id: row.id, typeId: row.type_id, typeName: row.type_name,
      startDate: row.start_date, endDate: row.end_date, days: number(row.days),
      halfDay: row.half_day, status: row.status, createdAt: row.created_at,
    })),
  };
}

function matchType(rows, value) {
  if (!value) return rows;
  const needle = value.toLowerCase();
  const exact = rows.filter((row) => row.name.toLowerCase() === needle);
  if (exact.length) return exact;
  const matches = rows.filter((row) => row.name.toLowerCase().includes(needle));
  if (!matches.length) throw Object.assign(new Error(`No leave type matches "${value}"`), { status: 400 });
  if (matches.length > 1) throw Object.assign(new Error(`"${value}" matches more than one leave type`), { status: 400 });
  return matches;
}

function parseFilters(args) {
  let year;
  let type;
  for (const arg of args) {
    if (/^\d{4}$/.test(arg)) {
      if (year !== undefined) throw Object.assign(new Error('Use only one year'), { status: 400 });
      year = parseYear(arg);
    } else {
      type = type ? `${type} ${arg}` : arg;
    }
  }
  return { year: parseYear(year), type };
}

function card(kind, title, year, data, actions = []) {
  return { visibility: 'private', kind, title, period: String(year), data, actions };
}

async function balances(context, args, mode = 'summary') {
  const { year, type } = parseFilters(args);
  const data = await leaveData(context.userId, year);
  const rows = matchType(data.balances, type);
  const titles = {
    summary: 'Leave balance', count: 'Leave credits', used: 'Approved leave used',
    remaining: 'Leave remaining', details: 'Leave details',
  };
  return card(`leave-${mode}`, titles[mode], year, {
    leaveTypes: rows,
    requests: mode === 'details' ? data.requests.filter((request) => rows.some((row) => Number(row.typeId) === Number(request.typeId))) : undefined,
    note: 'Pending requests reserve credits and are shown separately. Approved future leave is included in used leave.',
    asOf: new Date().toISOString(),
  }, [{ type: 'open-route', route: 'leave' }]);
}

async function history(context, args, pendingOnly = false) {
  const { year, type } = parseFilters(args);
  const data = await leaveData(context.userId, year);
  const types = matchType(data.balances, type);
  const allowed = new Set(types.map((row) => Number(row.typeId)));
  const requests = data.requests.filter((row) => allowed.has(Number(row.typeId)) && (!pendingOnly || row.status === 'pending'));
  return card(pendingOnly ? 'leave-pending' : 'leave-history', pendingOnly ? 'Pending leave requests' : 'Leave history', year, { requests }, [{ type: 'open-route', route: 'leave' }]);
}

async function leaveTypes(context, args) {
  if (args.length) throw Object.assign(new Error('/leave-types does not take arguments'), { status: 400 });
  const year = parseYear();
  const data = await leaveData(context.userId, year);
  return card('leave-types', 'Leave types', year, { leaveTypes: data.balances }, [{ type: 'open-route', route: 'leave' }]);
}

async function cancelCandidate(context, args) {
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    throw Object.assign(new Error('Use /leave-cancel followed by the request number'), { status: 400 });
  }
  const requestId = Number(args[0]);
  const row = (await query(
    `SELECT r.id, r.status, to_char(r.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(r.end_date, 'YYYY-MM-DD') AS end_date, r.days, t.name AS type_name
     FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
     WHERE r.id = $1 AND r.user_id = $2`,
    [requestId, context.userId]
  )).rows[0];
  if (!row) throw Object.assign(new Error('Leave request not found'), { status: 404 });
  const today = new Date().toISOString().slice(0, 10);
  if (row.status !== 'pending' && !(row.status === 'approved' && row.end_date >= today)) {
    throw Object.assign(new Error('Only pending or upcoming approved leave can be cancelled'), { status: 400 });
  }
  return {
    visibility: 'private', kind: 'leave-cancel', title: 'Cancel leave request',
    data: {
      message: `${row.type_name}: ${row.start_date}${row.end_date === row.start_date ? '' : ` to ${row.end_date}`} (${number(row.days)} day${number(row.days) === 1 ? '' : 's'})`,
    },
    actions: [{ type: 'cancel-leave', requestId: row.id }],
  };
}

module.exports = { balances, history, leaveTypes, cancelCandidate, parseFilters };
