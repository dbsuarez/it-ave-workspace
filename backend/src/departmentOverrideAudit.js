// Phase 3 transition audit: department overrides historically combined entry and actions.
// Never silently delete or convert existing rules; report them for an explicit migration.
const CONTENT_ACCESS = 'view_channel';
function summarizeDepartmentOverrides(rows) {
  return (rows || []).map((row) => {
    const allow = Array.isArray(row.allow) ? row.allow : [];
    const deny = Array.isArray(row.deny) ? row.deny : [];
    return {
      channelId: Number(row.channel_id), departmentId: Number(row.subject_id),
      access: { allow: allow.includes(CONTENT_ACCESS), deny: deny.includes(CONTENT_ACCESS) },
      actionAllows: allow.filter((p) => p !== CONTENT_ACCESS),
      actionDenies: deny.filter((p) => p !== CONTENT_ACCESS),
      requiresManualMigration: allow.some((p) => p !== CONTENT_ACCESS) || deny.some((p) => p !== CONTENT_ACCESS),
    };
  });
}
async function auditDepartmentOverrides(query) {
  const result = await query(`SELECT channel_id, subject_id, allow, deny
    FROM channel_overrides WHERE subject_type = 'department'
    ORDER BY channel_id, subject_id`);
  return summarizeDepartmentOverrides(result.rows);
}
module.exports = { summarizeDepartmentOverrides, auditDepartmentOverrides };
