// Who may manage employees: the Superadmin, and anyone the Superadmin has given the HR role.
// HR can keep employee records, departments, reporting lines and names, and create member accounts.
// Only the Superadmin gives out roles (HR, Superadmin, guest) and moderates.
const crypto = require('crypto');
const { query } = require('./db');

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

// The caller's account with what decides their HR access, or throws 401.
async function hrActor(userId) {
  const result = await query('SELECT id, account_type, is_superadmin, is_hr FROM users WHERE id = $1', [userId]);
  const row = result.rows[0];
  if (!row) throw fail(401, 'Account not found');
  return row;
}

const canManageEmployees = (actor) => Boolean(actor && actor.account_type === 'member' && (actor.is_superadmin || actor.is_hr));

async function requireHr(userId) {
  const actor = await hrActor(userId);
  if (!canManageEmployees(actor)) throw fail(403, 'Only the Superadmin or HR can do that');
  return actor;
}

async function requireSuperadmin(userId) {
  const actor = await hrActor(userId);
  if (!actor.is_superadmin) throw fail(403, 'Only the Superadmin can do that');
  return actor;
}

// no 0/O, 1/l/I: a temporary password gets read out and typed
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function temporaryPassword() {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

// Give someone the checklist HR keeps for 'onboarding' or 'offboarding', unless they already have one of that kind.
async function applyChecklist(userId, kind) {
  const existing = await query('SELECT 1 FROM employee_tasks WHERE user_id = $1 AND kind = $2 LIMIT 1', [userId, kind]);
  if (existing.rows.length) return 0;
  const inserted = await query(
    `INSERT INTO employee_tasks (user_id, kind, title, position)
     SELECT $1::int, kind, title, position FROM hr_task_templates WHERE kind = $2 ORDER BY position, id RETURNING id`,
    [userId, kind]
  );
  return inserted.rows.length;
}

module.exports = { fail, hrActor, canManageEmployees, requireHr, requireSuperadmin, temporaryPassword, applyChecklist };
