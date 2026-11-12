// IT Avenue Workspace - roles and permissions: the one place that answers "may this person do this?".
// Design: docs/ROLES_DESIGN.md. Phase 1: the engine, built-in roles and the migration of today's flags
// (users.is_superadmin = Owner, users.is_hr = HR); the flags stay the source of truth for those two roles for now.
//
// Order of evaluation (Discord's, simplified):
//   1. An Owner may do everything.
//   2. Start from the union of the permissions of Everyone and every role the person holds.
//   3. In a channel, apply that channel's overrides: the Everyone role's, then the person's other roles' (all denies, then
//      all allows, so an allow from any role wins over a deny from another), then the person's own.
//   Channel moderators (channel_members.role) are treated as holding manage_messages and timeout_members in that channel.

const PERMISSIONS = [
  ['view_channel', 'See a channel and read its history'],
  ['send_messages', 'Send messages'],
  ['attach_files', 'Attach files'],
  ['add_reactions', 'Add reactions'],
  ['mention_everyone', 'Use @channel, @here and @everyone (reserved: not available yet)'],
  ['create_channels', 'Create channels'],
  ['manage_channels', 'Edit and delete any channel'],
  ['manage_messages', 'Delete or pin other people\'s messages'],
  ['timeout_members', 'Time people out in a channel'],
  ['manage_roles', 'Create roles and give them to people'],
  ['manage_people', 'Employee records, leave and attendance (HR)'],
  ['view_audit_log', 'Read the moderation audit log'],
  ['manage_workspace', 'Workspace settings, integrations and slow mode'],
].map(([key, label]) => ({ key, label }));

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const isPermission = (key) => PERMISSION_KEYS.includes(key);

// What the built-in roles start with (the migration seeds these; Owner is always everything and is not editable).
const EVERYONE_DEFAULTS = ['view_channel', 'send_messages', 'attach_files', 'add_reactions', 'create_channels'];
const HR_DEFAULTS = ['manage_people'];

// The pure rule. `grants` is every role the person has (the Everyone role included, flagged by key 'everyone'),
// each { key, permissions: [] }; `overrides` is { everyone, roles: [{ allow, deny }], user } for one channel or null.
function resolvePermission({ isOwner, grants, overrides, channelModerator }, permission) {
  if (isOwner) return true;
  const set = new Set();
  for (const grant of grants) for (const key of grant.permissions || []) set.add(key);
  if (overrides) {
    const apply = (entry) => {
      if (!entry) return;
      for (const key of entry.deny || []) set.delete(key);
      for (const key of entry.allow || []) set.add(key);
    };
    apply(overrides.everyone);
    const roles = overrides.roles || [];
    for (const entry of roles) for (const key of entry.deny || []) set.delete(key);
    for (const entry of roles) for (const key of entry.allow || []) set.add(key);
    apply(overrides.user);
  }
  if (channelModerator && (permission === 'manage_messages' || permission === 'timeout_members')) {
    // a moderator's powers are an allow in their channel, which an explicit deny for them can still remove
    const denied = overrides && overrides.user && (overrides.user.deny || []).includes(permission);
    if (!denied) return true;
  }
  return set.has(permission);
}

// Everything the database knows about one person's access, in two small queries.
async function loadAccess(query, userId, channelId) {
  const account = await query(
    'SELECT is_superadmin, is_hr, account_type FROM users WHERE id = $1 AND deactivated_at IS NULL', [userId]
  );
  const row = account.rows[0];
  if (!row) return null;
  const rolesResult = await query(
    `SELECT r.id, r.name, r.builtin_key, r.permissions
     FROM roles r
     WHERE r.builtin_key = 'everyone'
        OR r.id IN (SELECT role_id FROM user_roles WHERE user_id = $1)
        OR ($2::boolean AND r.builtin_key = 'hr')
        OR ($3::boolean AND r.builtin_key = 'owner')`,
    [userId, Boolean(row.is_hr), Boolean(row.is_superadmin)]
  );
  const roles = rolesResult.rows;
  const isOwner = Boolean(row.is_superadmin) || roles.some((r) => r.builtin_key === 'owner');
  const access = {
    isOwner,
    accountType: row.account_type,
    roleIds: roles.map((r) => Number(r.id)),
    grants: roles.map((r) => ({ key: r.builtin_key || null, name: r.name || '', permissions: r.permissions || [] })),
    overrides: null,
    channelModerator: false,
  };
  if (channelId) {
    const everyone = roles.find((r) => r.builtin_key === 'everyone');
    const overrides = await query(
      `SELECT co.subject_type, co.subject_id, co.allow, co.deny, r.name AS role_name FROM channel_overrides co
       LEFT JOIN roles r ON co.subject_type = 'role' AND r.id = co.subject_id
       WHERE co.channel_id = $1 AND ((co.subject_type = 'user' AND co.subject_id = $2) OR (co.subject_type = 'role' AND co.subject_id = ANY($3::int[])))`,
      [channelId, userId, access.roleIds]
    );
    access.overrides = { everyone: null, roles: [], user: null };
    for (const o of overrides.rows) {
      const entry = { allow: o.allow || [], deny: o.deny || [], name: o.role_name || '' };
      if (o.subject_type === 'user') access.overrides.user = entry;
      else if (everyone && Number(o.subject_id) === Number(everyone.id)) access.overrides.everyone = entry;
      else access.overrides.roles.push(entry);
    }
    const moderator = await query(
      "SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2 AND role = 'moderator'", [channelId, userId]
    );
    access.channelModerator = moderator.rows.length > 0;
  }
  return access;
}

// The same answer as resolvePermission, with the reason: { allowed, reason }. Used by the access checker, so a wrong
// setup can be understood; test/permissions.test.js proves the two always agree.
function explainPermission({ isOwner, grants, overrides, channelModerator }, permission) {
  if (isOwner) return { allowed: true, reason: 'Owner: always allowed' };
  const names = (list) => list.map((entry) => entry.name || 'a role').join(', ');
  const givers = grants.filter((grant) => (grant.permissions || []).includes(permission));
  let allowed = givers.length > 0;
  let reason = allowed ? `Given by ${givers.map((g) => g.name || g.key).join(', ')}` : 'No role gives it';
  if (overrides) {
    const step = (entry, who) => {
      if (!entry) return;
      if ((entry.deny || []).includes(permission)) { allowed = false; reason = `Denied in this channel for ${who}`; }
      if ((entry.allow || []).includes(permission)) { allowed = true; reason = `Allowed in this channel for ${who}`; }
    };
    step(overrides.everyone, 'Everyone');
    const roles = overrides.roles || [];
    const denying = roles.filter((entry) => (entry.deny || []).includes(permission));
    const allowing = roles.filter((entry) => (entry.allow || []).includes(permission));
    if (denying.length) { allowed = false; reason = `Denied in this channel for ${names(denying)}`; }
    if (allowing.length) { allowed = true; reason = `Allowed in this channel for ${names(allowing)}`; }
    step(overrides.user, 'this person');
  }
  if (channelModerator && (permission === 'manage_messages' || permission === 'timeout_members')) {
    const denied = overrides && overrides.user && (overrides.user.deny || []).includes(permission);
    if (!denied) return { allowed: true, reason: 'Channel moderator in this channel' };
  }
  return { allowed, reason };
}

// May this person do this (optionally in one channel)? False for an unknown or deactivated account.
async function can(query, userId, permission, { channelId = null } = {}) {
  if (!isPermission(permission)) throw new Error(`Unknown permission: ${permission}`);
  if (!userId) return false;
  const access = await loadAccess(query, userId, channelId);
  return access ? resolvePermission(access, permission) : false;
}

// Throws a 403 (the app's usual shape) when they may not.
async function requirePermission(query, userId, permission, options = {}) {
  if (!(await can(query, userId, permission, options))) {
    throw Object.assign(new Error('You do not have permission to do that'), { status: 403 });
  }
}

// SQL for "does this channel need the full permission check for this permission?": true when a channel override mentions
// it, or when the Everyone role no longer grants it. Otherwise every member has it and the check can be skipped, which
// keeps ordinary channels at zero extra queries. `permission` is one of PERMISSION_KEYS; `channelParam` is like '$1'.
function needsCheckSql(permission, channelParam) {
  if (!isPermission(permission)) throw new Error(`Unknown permission: ${permission}`);
  return `(EXISTS (SELECT 1 FROM channel_overrides co WHERE co.channel_id = ${channelParam}
            AND ('${permission}' = ANY(co.allow) OR '${permission}' = ANY(co.deny)))
          OR COALESCE((SELECT NOT ('${permission}' = ANY(r.permissions)) FROM roles r WHERE r.builtin_key = 'everyone'), false))`;
}

// Of these channel rows ({ id, ... }), the ones this person may see: a channel whose settings (or an edited Everyone role)
// take viewing away from them is left out. Ordinary channels cost one cheap query for the whole list.
async function viewableChannels(query, userId, rows) {
  if (!rows.length) return rows;
  const flagged = (await query(
    `SELECT c.id FROM channels c WHERE c.id = ANY($1::int[]) AND ${needsCheckSql('view_channel', 'c.id')}`, [rows.map((r) => r.id)]
  )).rows.map((r) => Number(r.id));
  if (!flagged.length) return rows;
  const hidden = new Set();
  for (const id of flagged) if (!(await can(query, userId, 'view_channel', { channelId: id }))) hidden.add(id);
  return rows.filter((r) => !hidden.has(Number(r.id)));
}

module.exports = {
  explainPermission,
  viewableChannels,
  needsCheckSql,
  PERMISSIONS, PERMISSION_KEYS, EVERYONE_DEFAULTS, HR_DEFAULTS, isPermission,
  resolvePermission, loadAccess, can, requirePermission,
};
