// Explicit, one-time reset of non-Owner employee role grants and individual ACTION overrides.
// No startup hook: caller must be an authorized Superadmin with a confirmation phrase.
const { pool } = require('./db');
const ACTION_KEYS = Object.freeze([
  'send_messages', 'attach_files', 'add_reactions', 'mention_everyone',
  'create_channels', 'manage_channels', 'manage_messages', 'timeout_members',
  'manage_roles', 'manage_people', 'view_audit_log', 'manage_workspace',
  'manage_personal_channels',
]);
const CONFIRMATION = 'RESET EMPLOYEE ROLES';

async function resetEmployeeRoles(actorId, confirmation, connectionPool = pool) {
  if (confirmation !== CONFIRMATION) {
    const error = new Error('Type RESET EMPLOYEE ROLES to confirm');
    error.status = 400;
    throw error;
  }
  const client = await connectionPool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    // Recheck within the same transaction as the destructive operation.
    const actor = await client.query(
      'SELECT id FROM users WHERE id = $1 AND is_superadmin = TRUE AND deactivated_at IS NULL FOR UPDATE',
      [actorId]
    );
    if (!actor.rows.length) {
      const error = new Error('Superadmin access required');
      error.status = 403;
      throw error;
    }
    // Owner and guest accounts are excluded, including deactivated employees.
    // An Employee is an account_type=member with only the Everyone/base role.
    const employees = await client.query(
      "SELECT id FROM users WHERE account_type = 'member' AND is_superadmin = FALSE FOR UPDATE"
    );
    const ids = employees.rows.map((row) => Number(row.id));
    let rolesRemoved = 0;
    let overridesChanged = 0;
    if (ids.length) {
      const roles = await client.query(
        'DELETE FROM user_roles WHERE user_id = ANY($1::int[]) RETURNING user_id', [ids]
      );
      rolesRemoved = roles.rowCount ?? roles.rows.length;
      // Preserve view_channel allowances and denials, since these may still
      // determine private channel visibility. Remove only action permissions.
      const updates = await client.query(
        `UPDATE channel_overrides
         SET allow = ARRAY(SELECT unnest(allow) EXCEPT SELECT unnest($2::text[])),
             deny = ARRAY(SELECT unnest(deny) EXCEPT SELECT unnest($2::text[]))
         WHERE subject_type = 'user' AND subject_id = ANY($1::int[])
           AND (allow && $2::text[] OR deny && $2::text[])
         RETURNING channel_id`,
        [ids, ACTION_KEYS]
      );
      overridesChanged = updates.rowCount ?? updates.rows.length;
      // Legacy HR indicator should not represent continuing HR privileges.
      await client.query('UPDATE users SET is_hr = FALSE WHERE id = ANY($1::int[])', [ids]);
    }
    const details = { employeeCount: ids.length, rolesRemoved, overridesChanged, preserves: ['departments', 'channel memberships', 'channel bans', 'invites', 'channel view overrides', 'content'] };
    await client.query(
      `INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details)
       VALUES (NULL, $1, NULL, $2, $3)`,
      [actorId, 'employee_role_reset', JSON.stringify(details)]
    );
    await client.query('COMMIT');
    committed = true;
    return details;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { resetEmployeeRoles, CONFIRMATION, ACTION_KEYS };
