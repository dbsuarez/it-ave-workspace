// Pre-launch shared test password.
//
// While the workspace is being tested, every employee uses one known password so nobody is locked out and the
// Superadmin does not have to hand out passwords. It is a switch (moderation_settings.prelaunch_password):
//   - ON : new accounts get the shared password and are not forced to change it; "apply" sets it on every
//          existing employee (members). Superadmins keep their own passwords; guests and bots are not touched.
//   - go live : turns the switch OFF and makes every employee choose a new password at their next sign-in.
// The shared password is PRELAUNCH_PASSWORD (default testpass123). Do not leave this on for real use: anyone who
// knows it can sign in as any employee.
const bcrypt = require('bcryptjs');
const { query } = require('./db');

const PASSWORD = process.env.PRELAUNCH_PASSWORD || 'testpass123';

async function isEnabled() {
  const result = await query('SELECT prelaunch_password FROM moderation_settings WHERE id = 1');
  return Boolean(result.rows[0] && result.rows[0].prelaunch_password);
}

async function setEnabled(enabled) {
  await query('UPDATE moderation_settings SET prelaunch_password = $1 WHERE id = 1', [Boolean(enabled)]);
}

// Set the shared password on every active member who is not a Superadmin. Signs them out (new token version).
// Returns the ids, so the caller can drop their live connections.
async function applyToAll() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const result = await query(
    `UPDATE users SET password_hash = $1, must_change_password = false, token_version = token_version + 1
     WHERE account_type = 'member' AND NOT is_superadmin AND deactivated_at IS NULL RETURNING id`,
    [hash]
  );
  return result.rows.map((r) => r.id);
}

// Switch off, and require a new password from every active member who is not a Superadmin.
async function goLive() {
  await setEnabled(false);
  const result = await query(
    `UPDATE users SET must_change_password = true
     WHERE account_type = 'member' AND NOT is_superadmin AND deactivated_at IS NULL RETURNING id`
  );
  return result.rows.map((r) => r.id);
}

module.exports = { PASSWORD, isEnabled, setEnabled, applyToAll, goLive };
