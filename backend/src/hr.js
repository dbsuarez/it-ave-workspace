// Who may manage employees: the Superadmin, and anyone the Superadmin has given the HR role.
// HR can keep employee records, departments, reporting lines and names, and create member accounts.
// Only the Superadmin gives out roles (HR, Superadmin, guest) and moderates.
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

module.exports = { fail, hrActor, canManageEmployees, requireHr, requireSuperadmin };
