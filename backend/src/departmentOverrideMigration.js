// Phase 3. A conservative transition plan for historical department overrides.
// This planner does not alter existing effective permissions, roles, or access.
// Operators must review the resulting blockers before an explicit migration.
const ACCESS = 'view_channel';
function planDepartmentOverrideMigration(rows) {
  return (rows || []).map((row) => {
    const allow = Array.isArray(row.allow) ? row.allow : [];
    const deny = Array.isArray(row.deny) ? row.deny : [];
    const actions = [...new Set([...allow, ...deny].filter((permission) => permission !== ACCESS))];
    const conflict = allow.includes(ACCESS) && deny.includes(ACCESS);
    const blockers = [];
    if (actions.length) blockers.push('department_action_override_requires_explicit_role_or_user_mapping');
    if (deny.includes(ACCESS)) blockers.push('department_access_deny_requires_explicit_ban_or_access_policy_review');
    if (conflict) blockers.push('contradictory_access_override');
    return {
      channelId: Number(row.channel_id),
      departmentId: Number(row.subject_id),
      accessAllow: allow.includes(ACCESS),
      accessDeny: deny.includes(ACCESS),
      actionAllows: allow.filter((key) => key !== ACCESS),
      actionDenies: deny.filter((key) => key !== ACCESS),
      blockers,
      safeToConvertAccessAllow: allow.includes(ACCESS) && blockers.length === 0,
      // No automatic delete/update of legacy overrides: retain both old access and old actions
      // until staging parity has been checked and an explicit change window is approved.
    };
  });
}
async function readDepartmentOverrideMigrationPlan(query) {
  const { rows } = await query(`SELECT channel_id, subject_id, allow, deny
    FROM channel_overrides WHERE subject_type = 'department'
    ORDER BY channel_id, subject_id`);
  return planDepartmentOverrideMigration(rows);
}
// Dry-run-by-default migration, never executed by application startup. The caller must provide
// a dedicated PostgreSQL client (all queries must use the SAME transaction).
// Only an uncontested, access-only allow is eligible. This function checks actual
// users' effective membership AND view permission inside the transaction before
// committing; any drift aborts and rolls the entire operation back.
// WARNING: this checks current active accounts, not future department movements.
// Use a dedicated client, staging database, and reviewed change window.
async function migrateAccessOnlyDepartmentOverride(client, { channelId, departmentId, approved = false, dryRun = true } = {}) {
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean');
  if (!dryRun && approved !== true) throw new Error('Explicit approved=true is required to commit');
  if (![channelId, departmentId].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Valid channelId and departmentId are required');
  }
  const query = client.query.bind(client);
  const { ensureChannelMembership } = require('./security');
  const allowed = async (userId) => {
    try { await ensureChannelMembership(query, userId, channelId); return true; }
    catch (err) { if (err.status === 403 || err.status === 404) return false; throw err; }
  };
  await query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  let transactionOpen = true;
  try {
    // Prevent two concurrent policy migrations from inspecting the same row.
    const result = await query(`SELECT channel_id, subject_id, allow, deny FROM channel_overrides
      WHERE channel_id = $1 AND subject_type = 'department' AND subject_id = $2 FOR UPDATE`,
    [channelId, departmentId]);
    if (result.rows.length !== 1) throw new Error('Department override not found');
    const [plan] = planDepartmentOverrideMigration(result.rows);
    if (!plan.safeToConvertAccessAllow || plan.actionAllows.length || plan.actionDenies.length) {
      throw new Error(`Unsafe legacy rule: ${plan.blockers.join(', ') || 'not access-only'}`);
    }
    // Ensure no other department policy depends on this migration implicitly.
    const users = (await query('SELECT id FROM users WHERE deactivated_at IS NULL ORDER BY id')).rows;
    const before = [];
    for (const user of users) before.push(await allowed(user.id));
    await query(`INSERT INTO channel_department_grants(channel_id, department_id)
      VALUES ($1, $2) ON CONFLICT (channel_id, department_id) DO NOTHING`, [channelId, departmentId]);
    // A zero-row delete is treated as a concurrent / unexpected mutation.
    const removed = await query(`DELETE FROM channel_overrides WHERE channel_id = $1
      AND subject_type = 'department' AND subject_id = $2 RETURNING channel_id`, [channelId, departmentId]);
    if (removed.rows.length !== 1) throw new Error('Legacy override changed during conversion');
    for (let i = 0; i < users.length; i++) {
      if ((await allowed(users[i].id)) !== before[i]) {
        throw new Error(`Effective channel access changed for user ${users[i].id}; migration rolled back`);
      }
    }
    if (dryRun) {
      await query('ROLLBACK');
      transactionOpen = false;
      return { channelId, departmentId, checkedUsers: users.length, converted: false, safeToCommit: true, dryRun: true };
    }
    await query('COMMIT');
    transactionOpen = false;
    return { channelId, departmentId, checkedUsers: users.length, converted: true, dryRun: false };
  } catch (err) {
    if (transactionOpen) {
      try { await query('ROLLBACK'); }
      catch (rollbackErr) { err.rollbackError = rollbackErr; }
    }
    throw err;
  }
}
module.exports = { planDepartmentOverrideMigration, readDepartmentOverrideMigrationPlan, migrateAccessOnlyDepartmentOverride };
