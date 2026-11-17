// Phase 2 access policy foundation. Not yet connected to legacy channel routes.
// This module intentionally does not interpret department membership as an action permission.
function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeExpiration(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('Expiration must be an ISO date-time string');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now) throw new RangeError('Expiration must be in the future');
  return new Date(parsed).toISOString();
}

function effectiveAccess({ active, banned, departmentIds = [], allowedDepartmentIds = [], directGrant = null }, now = Date.now()) {
  if (!active || banned) return { allowed: false, sources: [] };
  const permitted = new Set(allowedDepartmentIds.map(positiveId).filter(Boolean));
  const sources = [...new Set(departmentIds.map(positiveId).filter(id => id && permitted.has(id)))].map(id => `department:${id}`);
  if (directGrant && (directGrant.expiresAt == null || Date.parse(directGrant.expiresAt) > now)) sources.push('direct');
  return { allowed: sources.length > 0, sources };
}

async function inspectAccess(query, channelId, userId) {
  const channel = positiveId(channelId), user = positiveId(userId);
  if (!channel || !user) throw new TypeError('Valid channel and user IDs are required');
  const result = await query(`SELECT u.deactivated_at IS NULL AND u.account_type = 'member' AS active,
       EXISTS(SELECT 1 FROM channel_bans b WHERE b.channel_id = $1 AND b.user_id = $2) AS banned,
       ARRAY(SELECT ud.department_id FROM user_departments ud WHERE ud.user_id = $2) AS department_ids,
       ARRAY(SELECT cdg.department_id FROM channel_department_grants cdg WHERE cdg.channel_id = $1) AS allowed_department_ids,
       (SELECT expires_at FROM channel_direct_grants dg WHERE dg.channel_id = $1 AND dg.user_id = $2) AS expires_at,
       EXISTS(SELECT 1 FROM channel_direct_grants dg WHERE dg.channel_id = $1 AND dg.user_id = $2) AS direct_exists
     FROM users u JOIN channels c ON c.id = $1 WHERE u.id = $2`, [channel, user]);
  if (!result.rows.length) return { allowed: false, sources: [] };
  const row = result.rows[0];
  return effectiveAccess({ active: row.active, banned: row.banned, departmentIds: row.department_ids,
    allowedDepartmentIds: row.allowed_department_ids,
    directGrant: row.direct_exists ? { expiresAt: row.expires_at } : null });
}

module.exports = { positiveId, normalizeExpiration, effectiveAccess, inspectAccess };
