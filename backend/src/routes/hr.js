// Employee management: records (employee number, hire date, status, type, department), departments, the HR
// role, and a CSV export. Open to the Superadmin and to HR; departments can be read by every member.
const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { fail, hrActor, canManageEmployees, requireHr, requireSuperadmin, temporaryPassword, applyChecklist } = require('../hr');

const router = express.Router();
router.use(authenticateToken);

const STATUSES = ['active', 'on_leave', 'resigned'];
const TYPES = ['', 'regular', 'probationary', 'contractual', 'part_time', 'intern'];

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

// '' or null -> null; otherwise a real calendar date as YYYY-MM-DD.
function dateOrNull(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail(400, `${label} must be a date (YYYY-MM-DD)`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw fail(400, `${label} is not a real date`);
  return value;
}

const EMPLOYEE_SELECT = `
  SELECT u.id, u.username, u.email, u.last_name, u.first_name, u.middle_name, u.job_title, u.location,
         u.department_id, u.department, u.manager_id, u.employee_no,
         to_char(u.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(u.separation_date, 'YYYY-MM-DD') AS separation_date,
         u.employment_status, u.employment_type, u.is_hr, u.is_superadmin, u.last_seen, u.created_at,
         u.profile->>'phone' AS phone, u.deactivated_at, u.photo_file, u.photo_updated_at,
         (SELECT COUNT(*)::int FROM employee_tasks t WHERE t.user_id = u.id AND t.kind = 'onboarding') AS onboarding_total,
         (SELECT COUNT(*)::int FROM employee_tasks t WHERE t.user_id = u.id AND t.kind = 'onboarding' AND t.done_at IS NOT NULL) AS onboarding_done,
         (SELECT COUNT(*)::int FROM employee_tasks t WHERE t.user_id = u.id AND t.kind = 'offboarding') AS offboarding_total,
         (SELECT COUNT(*)::int FROM employee_tasks t WHERE t.user_id = u.id AND t.kind = 'offboarding' AND t.done_at IS NOT NULL) AS offboarding_done
  FROM users u`;

function mapEmployee(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    lastName: row.last_name || '',
    firstName: row.first_name || '',
    middleName: row.middle_name || '',
    jobTitle: row.job_title || '',
    location: row.location || '',
    phone: row.phone || '',
    departmentId: row.department_id || null,
    department: row.department || '',
    managerId: row.manager_id || null,
    employeeNo: row.employee_no || '',
    hireDate: row.hire_date || null,
    separationDate: row.separation_date || null,
    employmentStatus: row.employment_status,
    employmentType: row.employment_type || '',
    isHr: Boolean(row.is_hr),
    isSuperadmin: Boolean(row.is_superadmin),
    deactivatedAt: row.deactivated_at || null,
    checklists: {
      onboarding: { done: row.onboarding_done, total: row.onboarding_total },
      offboarding: { done: row.offboarding_done, total: row.offboarding_total },
    },
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    photoVersion: row.photo_file && row.photo_updated_at ? new Date(row.photo_updated_at).getTime() : null,
  };
}

// GET /api/hr/me - what the signed-in person may do here
router.get('/me', async (req, res) => {
  try {
    const actor = await hrActor(req.user.userId);
    res.json({ canManage: canManageEmployees(actor), isHr: Boolean(actor.is_hr), isSuperadmin: Boolean(actor.is_superadmin) });
  } catch (err) {
    sendError(res, err, 'HR access error');
  }
});

// GET /api/hr/employees - every member's record
router.get('/employees', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const result = await query(`${EMPLOYEE_SELECT} WHERE u.account_type = 'member' ORDER BY LOWER(COALESCE(NULLIF(u.last_name, ''), u.username)), LOWER(u.first_name)`);
    res.json({ employees: result.rows.map(mapEmployee) });
  } catch (err) {
    sendError(res, err, 'List employees error');
  }
});

// PUT /api/hr/employees/:id - change a record. Only the fields sent are changed.
router.put('/employees/:id', async (req, res) => {
  try {
    const actor = await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    const body = req.body || {};
    const sets = [];
    const values = [];
    const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

    if (body.username !== undefined) {
      // the name they sign in with: only the Superadmin changes it
      if (!actor.is_superadmin) throw fail(403, 'Only the Superadmin can change a username');
      const username = text(body.username, 50, 'Username');
      if (!username || /\s/.test(username)) throw fail(400, 'A username is 1 to 50 characters with no spaces');
      const taken = await query('SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2', [username, id]);
      if (taken.rows.length) throw fail(409, 'That username is already taken');
      set('username', username);
    }
    if (body.employeeNo !== undefined) {
      const number = text(body.employeeNo, 40, 'Employee number');
      if (number) {
        const taken = await query('SELECT id FROM users WHERE LOWER(employee_no) = LOWER($1) AND id <> $2', [number, id]);
        if (taken.rows.length) throw fail(409, 'That employee number is already used by someone else');
      }
      set('employee_no', number || null);
    }
    if (body.hireDate !== undefined) set('hire_date', dateOrNull(body.hireDate, 'Hire date'));
    if (body.separationDate !== undefined) set('separation_date', dateOrNull(body.separationDate, 'Last day'));
    if (body.employmentStatus !== undefined) {
      if (!STATUSES.includes(body.employmentStatus)) throw fail(400, 'Status must be active, on_leave or resigned');
      set('employment_status', body.employmentStatus);
    }
    if (body.employmentType !== undefined) {
      if (!TYPES.includes(body.employmentType)) throw fail(400, 'Unknown employment type');
      set('employment_type', body.employmentType);
    }
    for (const [field, column, label] of [['lastName', 'last_name', 'Last name'], ['firstName', 'first_name', 'First name'], ['middleName', 'middle_name', 'Middle name'], ['jobTitle', 'job_title', 'Job title'], ['location', 'location', 'Location']]) {
      if (body[field] !== undefined) set(column, text(body[field], 100, label));
    }
    if (body.departmentId !== undefined) {
      if (body.departmentId === null) {
        set('department_id', null);
        set('department', '');
      } else {
        const deptId = parseId(body.departmentId);
        const dept = deptId ? (await query('SELECT id, name FROM departments WHERE id = $1', [deptId])).rows[0] : null;
        if (!dept) throw fail(404, 'That department was not found');
        set('department_id', dept.id);
        set('department', dept.name);
      }
    }
    if (!sets.length) throw fail(400, 'Nothing to change');
    values.push(id);
    const before = body.username !== undefined ? (await query('SELECT username FROM users WHERE id = $1', [id])).rows[0] : null;
    const updated = await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length} AND account_type = 'member' RETURNING id`, values);
    if (!updated.rows.length) throw fail(404, 'Person not found');
    if (before && before.username !== body.username.trim()) {
      await query(
        "INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details) VALUES (NULL, $1, $2, 'username_changed', $3)",
        [actor.id, id, JSON.stringify({ from: before.username, to: body.username.trim() })]
      );
    }
    const row = (await query(`${EMPLOYEE_SELECT} WHERE u.id = $1`, [id])).rows[0];
    res.json({ employee: mapEmployee(row) });
  } catch (err) {
    sendError(res, err, 'Update employee error');
  }
});

// PUT /api/hr/employees/:id/hr-role - make someone HR, or take it away (Superadmin only)
router.put('/employees/:id/hr-role', async (req, res) => {
  try {
    await requireSuperadmin(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    if (typeof (req.body && req.body.isHr) !== 'boolean') throw fail(400, 'isHr must be true or false');
    const result = await query("UPDATE users SET is_hr = $1 WHERE id = $2 AND account_type = 'member' RETURNING id", [req.body.isHr, id]);
    if (!result.rows.length) throw fail(404, 'Person not found');
    res.json({ id, isHr: req.body.isHr });
  } catch (err) {
    sendError(res, err, 'Set HR role error');
  }
});

// ---- departments ----

const DEPARTMENT_SELECT = `
  SELECT d.id, d.name, d.head_id, h.username AS head_username,
         (SELECT COUNT(*)::int FROM users u WHERE u.department_id = d.id AND u.account_type = 'member') AS member_count
  FROM departments d LEFT JOIN users h ON h.id = d.head_id`;

const mapDepartment = (row) => ({ id: row.id, name: row.name, headId: row.head_id || null, headUsername: row.head_username || '', memberCount: row.member_count });

// GET /api/hr/departments - open to every member (the directory filters by it)
router.get('/departments', async (req, res) => {
  try {
    const actor = await hrActor(req.user.userId);
    if (actor.account_type !== 'member') throw fail(403, 'Guest accounts cannot browse departments');
    const result = await query(`${DEPARTMENT_SELECT} ORDER BY LOWER(d.name)`);
    res.json({ departments: result.rows.map(mapDepartment) });
  } catch (err) {
    sendError(res, err, 'List departments error');
  }
});

async function headIdFrom(body) {
  if (body.headId === undefined) return undefined;
  if (body.headId === null || body.headId === '') return null;
  const id = parseId(body.headId);
  const head = id ? (await query("SELECT id FROM users WHERE id = $1 AND account_type = 'member'", [id])).rows[0] : null;
  if (!head) throw fail(404, 'The department head was not found');
  return head.id;
}

router.post('/departments', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const name = text(req.body && req.body.name, 100, 'Department name');
    if (!name) throw fail(400, 'A department needs a name');
    const headId = await headIdFrom(req.body || {});
    if ((await query('SELECT 1 FROM departments WHERE LOWER(name) = LOWER($1)', [name])).rows.length) throw fail(409, 'There is already a department with that name');
    const created = await query('INSERT INTO departments (name, head_id) VALUES ($1, $2) RETURNING id', [name, headId === undefined ? null : headId]);
    const row = (await query(`${DEPARTMENT_SELECT} WHERE d.id = $1`, [created.rows[0].id])).rows[0];
    res.status(201).json({ department: mapDepartment(row) });
  } catch (err) {
    sendError(res, err, 'Create department error');
  }
});

router.put('/departments/:id', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid department ID is required');
    const existing = (await query('SELECT id, name FROM departments WHERE id = $1', [id])).rows[0];
    if (!existing) throw fail(404, 'Department not found');
    const body = req.body || {};
    let name = existing.name;
    if (body.name !== undefined) {
      name = text(body.name, 100, 'Department name');
      if (!name) throw fail(400, 'A department needs a name');
      if ((await query('SELECT 1 FROM departments WHERE LOWER(name) = LOWER($1) AND id <> $2', [name, id])).rows.length) throw fail(409, 'There is already a department with that name');
    }
    const headId = await headIdFrom(body);
    await query('UPDATE departments SET name = $1, head_id = CASE WHEN $2::boolean THEN $3 ELSE head_id END WHERE id = $4', [name, headId !== undefined, headId === undefined ? null : headId, id]);
    if (name !== existing.name) await query('UPDATE users SET department = $1 WHERE department_id = $2', [name, id]);
    const row = (await query(`${DEPARTMENT_SELECT} WHERE d.id = $1`, [id])).rows[0];
    res.json({ department: mapDepartment(row) });
  } catch (err) {
    sendError(res, err, 'Update department error');
  }
});

router.delete('/departments/:id', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid department ID is required');
    await query("UPDATE users SET department = '' WHERE department_id = $1", [id]);
    const result = await query('DELETE FROM departments WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) throw fail(404, 'Department not found');
    res.json({ id });
  } catch (err) {
    sendError(res, err, 'Delete department error');
  }
});

// ---- leaving, returning, and passwords ----

async function memberRow(id) {
  const row = (await query(
    "SELECT id, username, is_superadmin, manager_id, deactivated_at FROM users WHERE id = $1 AND account_type = 'member'", [id]
  )).rows[0];
  if (!row) throw fail(404, 'Person not found');
  return row;
}

async function employeeJson(id) {
  return mapEmployee((await query(`${EMPLOYEE_SELECT} WHERE u.id = $1`, [id])).rows[0]);
}

// POST /api/hr/employees/:id/deactivate - the person resigned or left: they can no longer sign in, and are signed
// out now. Their history stays. People who reported to them move up to their manager. { lastDay } is optional.
router.post('/employees/:id/deactivate', async (req, res) => {
  try {
    const actor = await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    if (id === Number(actor.id)) throw fail(400, 'You cannot deactivate your own account');
    const target = await memberRow(id);
    if (target.is_superadmin) throw fail(400, 'Take the Superadmin role away first');
    if (target.deactivated_at) throw fail(400, 'This account is already deactivated');
    const lastDay = dateOrNull(req.body && req.body.lastDay, 'Last day');
    await query(
      `UPDATE users SET deactivated_at = NOW(), employment_status = 'resigned', is_hr = false,
              separation_date = COALESCE($1::date, separation_date, CURRENT_DATE), token_version = token_version + 1
       WHERE id = $2`,
      [lastDay, id]
    );
    const moved = await query('UPDATE users SET manager_id = $1 WHERE manager_id = $2 RETURNING id', [target.manager_id, id]);
    await query('DELETE FROM user_secondary_managers WHERE user_id = $1 OR manager_id = $1', [id]);
    await query('UPDATE departments SET head_id = NULL WHERE head_id = $1', [id]);
    await applyChecklist(id, 'offboarding');
    req.io?.in(`user_${id}`).disconnectSockets(true);
    res.json({ employee: await employeeJson(id), reassignedReports: moved.rows.length });
  } catch (err) {
    sendError(res, err, 'Deactivate employee error');
  }
});

// POST /api/hr/employees/:id/reactivate - they are back. Reporting lines are not restored.
router.post('/employees/:id/reactivate', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    const target = await memberRow(id);
    if (!target.deactivated_at) throw fail(400, 'This account is not deactivated');
    await query("UPDATE users SET deactivated_at = NULL, employment_status = 'active', separation_date = NULL WHERE id = $1", [id]);
    res.json({ employee: await employeeJson(id) });
  } catch (err) {
    sendError(res, err, 'Reactivate employee error');
  }
});

// POST /api/hr/employees/:id/reset-password - a new temporary password, shown once; they must replace it
router.post('/employees/:id/reset-password', async (req, res) => {
  try {
    const actor = await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    const target = await memberRow(id);
    if (target.deactivated_at) throw fail(400, 'Reactivate this account first');
    if (target.is_superadmin && !actor.is_superadmin) throw fail(403, 'Only the Superadmin can reset a Superadmin\'s password');
    const password = temporaryPassword();
    await query(
      'UPDATE users SET password_hash = $1, must_change_password = true, token_version = token_version + 1 WHERE id = $2',
      [await bcrypt.hash(password, 10), id]
    );
    req.io?.in(`user_${id}`).disconnectSockets(true);
    res.json({ username: target.username, password });
  } catch (err) {
    sendError(res, err, 'Reset password error');
  }
});

// ---- onboarding and offboarding checklists ----

const KINDS = ['onboarding', 'offboarding'];
const MAX_TASKS = 40;

const mapTask = (row) => ({ id: row.id, kind: row.kind, title: row.title, done: Boolean(row.done_at), doneAt: row.done_at || null, doneBy: row.done_by_username || null });

const TASK_SELECT = `SELECT t.id, t.kind, t.title, t.done_at, d.username AS done_by_username
  FROM employee_tasks t LEFT JOIN users d ON d.id = t.done_by`;

router.get('/employees/:id/tasks', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    await memberRow(id);
    const result = await query(`${TASK_SELECT} WHERE t.user_id = $1 ORDER BY t.kind, t.position, t.id`, [id]);
    res.json({ tasks: result.rows.map(mapTask) });
  } catch (err) {
    sendError(res, err, 'List tasks error');
  }
});

router.post('/employees/:id/tasks', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    await memberRow(id);
    const body = req.body || {};
    if (!KINDS.includes(body.kind)) throw fail(400, 'kind must be onboarding or offboarding');
    if (body.apply === true) {
      // start the standard checklist (does nothing when they already have one)
      await applyChecklist(id, body.kind);
    } else {
      const title = text(body.title, 160, 'Task');
      if (!title) throw fail(400, 'A task needs a title');
      const count = await query('SELECT COUNT(*)::int AS n, COALESCE(MAX(position), 0) AS last FROM employee_tasks WHERE user_id = $1 AND kind = $2', [id, body.kind]);
      if (count.rows[0].n >= MAX_TASKS) throw fail(400, `A checklist can have at most ${MAX_TASKS} tasks`);
      await query('INSERT INTO employee_tasks (user_id, kind, title, position) VALUES ($1, $2, $3, $4)', [id, body.kind, title, count.rows[0].last + 1]);
    }
    const result = await query(`${TASK_SELECT} WHERE t.user_id = $1 ORDER BY t.kind, t.position, t.id`, [id]);
    res.status(201).json({ tasks: result.rows.map(mapTask) });
  } catch (err) {
    sendError(res, err, 'Add task error');
  }
});

router.put('/tasks/:taskId', async (req, res) => {
  try {
    const actor = await requireHr(req.user.userId);
    const taskId = parseId(req.params.taskId);
    if (taskId === null) throw fail(400, 'A valid task ID is required');
    if (typeof (req.body && req.body.done) !== 'boolean') throw fail(400, 'done must be true or false');
    const result = await query(
      'UPDATE employee_tasks SET done_at = CASE WHEN $1 THEN NOW() ELSE NULL END, done_by = CASE WHEN $1 THEN $2::int ELSE NULL END WHERE id = $3 RETURNING id',
      [req.body.done, actor.id, taskId]
    );
    if (!result.rows.length) throw fail(404, 'Task not found');
    const row = (await query(`${TASK_SELECT} WHERE t.id = $1`, [taskId])).rows[0];
    res.json({ task: mapTask(row) });
  } catch (err) {
    sendError(res, err, 'Update task error');
  }
});

router.delete('/tasks/:taskId', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const taskId = parseId(req.params.taskId);
    if (taskId === null) throw fail(400, 'A valid task ID is required');
    const result = await query('DELETE FROM employee_tasks WHERE id = $1 RETURNING id', [taskId]);
    if (!result.rows.length) throw fail(404, 'Task not found');
    res.json({ id: taskId });
  } catch (err) {
    sendError(res, err, 'Delete task error');
  }
});

// The standard checklists new hires and leavers start with.
router.get('/task-templates', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const result = await query('SELECT kind, title FROM hr_task_templates ORDER BY kind, position, id');
    res.json({
      onboarding: result.rows.filter((r) => r.kind === 'onboarding').map((r) => r.title),
      offboarding: result.rows.filter((r) => r.kind === 'offboarding').map((r) => r.title),
    });
  } catch (err) {
    sendError(res, err, 'List task templates error');
  }
});

// PUT /api/hr/task-templates - { kind, titles: [...] } replaces that checklist template. Existing people keep their lists.
router.put('/task-templates', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const body = req.body || {};
    if (!KINDS.includes(body.kind)) throw fail(400, 'kind must be onboarding or offboarding');
    if (!Array.isArray(body.titles) || body.titles.length > MAX_TASKS) throw fail(400, `titles must be a list of at most ${MAX_TASKS} tasks`);
    const titles = body.titles.map((title) => text(title, 160, 'Task')).filter(Boolean);
    await query('DELETE FROM hr_task_templates WHERE kind = $1', [body.kind]);
    if (titles.length) {
      await query('INSERT INTO hr_task_templates (kind, title, position) SELECT $1, t, ord FROM unnest($2::text[]) WITH ORDINALITY AS x(t, ord)', [body.kind, titles]);
    }
    res.json({ kind: body.kind, titles });
  } catch (err) {
    sendError(res, err, 'Save task templates error');
  }
});

// ---- export ----

// A CSV cell: quoted when needed, and one that could start a formula is defused so a spreadsheet never runs it.
// = and @ always count; + and - do too, unless the whole cell is a phone-like number such as +63 922 766 7968.
function csvCell(value) {
  let cell = value === null || value === undefined ? '' : String(value);
  if (/^[=@\t\r]/.test(cell) || (/^[+-]/.test(cell) && !/^[+-][\d\s().-]+$/.test(cell))) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

// GET /api/hr/export - the employee table as CSV
router.get('/export', async (req, res) => {
  try {
    await requireHr(req.user.userId);
    const result = await query(`${EMPLOYEE_SELECT} WHERE u.account_type = 'member' ORDER BY LOWER(COALESCE(NULLIF(u.last_name, ''), u.username)), LOWER(u.first_name)`);
    const employees = result.rows.map(mapEmployee);
    const nameOf = new Map(employees.map((e) => [e.id, [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ') || e.username]));
    const header = ['Employee no.', 'Last name', 'First name', 'Middle name', 'Username', 'Email', 'Job title', 'Department', 'Employment type', 'Status', 'Hire date', 'Last day', 'Location', 'Phone', 'Reports to'];
    const lines = [header.join(',')].concat(employees.map((e) => [
      e.employeeNo, e.lastName, e.firstName, e.middleName, e.username, e.email, e.jobTitle, e.department, e.employmentType.replace('_', ' '),
      e.employmentStatus.replace('_', ' '), e.hireDate, e.separationDate, e.location, e.phone, e.managerId ? nameOf.get(e.managerId) : '',
    ].map(csvCell).join(',')));
    res.json({ csv: `${lines.join('\r\n')}\r\n`, count: employees.length });
  } catch (err) {
    sendError(res, err, 'Export employees error');
  }
});

module.exports = router;
