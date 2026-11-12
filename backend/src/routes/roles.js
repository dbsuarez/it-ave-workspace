// Roles: GET /api/roles (list), POST (create), PUT /:id (edit), DELETE /:id, PUT /:id/move {direction},
// PUT /users/:userId {roleIds} (the custom roles someone holds), GET /permissions (the catalog).
// Owner and HR are built in: they are given and taken away with the Superadmin and HR switches on the person's record.
// Rules (hierarchy, what you may grant) live in src/roles.js; every change is written to the audit log.
const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { PERMISSIONS, can, loadAccess, explainPermission } = require('../permissions');
const { VIEW_AS_MINUTES } = require('../viewAs');
const { actorProfile, canManageRole, ungrantable, cleanRoleInput, roleHandle, MAX_CUSTOM_ROLES } = require('../roles');

const router = express.Router();
router.use(authenticateToken);

const fail = (status, message) => Object.assign(new Error(message), { status });
const parseId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function audit(actorId, action, targetUserId, details) {
  await query(
    'INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details) VALUES (NULL, $1, $2, $3, $4)',
    [actorId, targetUserId, action, JSON.stringify(details)]
  );
}

// The caller, who must hold manage_roles, with their rank and permissions.
async function requireRoleManager(userId) {
  if (!(await can(query, userId, 'manage_roles'))) throw fail(403, 'You cannot manage roles');
  const account = (await query('SELECT is_superadmin, is_hr FROM users WHERE id = $1', [userId])).rows[0];
  const roles = (await query(
    `SELECT id, name, position, permissions, builtin_key FROM roles
     WHERE builtin_key = 'everyone' OR id IN (SELECT role_id FROM user_roles WHERE user_id = $1)
        OR ($2::boolean AND builtin_key = 'hr') OR ($3::boolean AND builtin_key = 'owner')`,
    [userId, Boolean(account.is_hr), Boolean(account.is_superadmin)]
  )).rows;
  return { id: userId, ...actorProfile({ isOwner: Boolean(account.is_superadmin) || roles.some((r) => r.builtin_key === 'owner'), roles }) };
}

async function roleById(id) {
  return (await query('SELECT id, name, color, position, permissions, builtin_key FROM roles WHERE id = $1', [id])).rows[0];
}

const mapRole = (row, actor) => ({
  id: row.id, name: row.name, color: row.color, position: row.position, permissions: row.permissions,
  builtin: row.builtin_key || null, memberCount: Number(row.member_count || 0),
  canManage: canManageRole(actor, row), canRename: !row.builtin_key,
});

// Roles anyone can @mention (every role but Everyone), for the composer: [{ id, name, handle, color, memberCount }].
router.get('/mentionable', async (req, res) => {
  try {
    const result = await query(
      `SELECT r.id, r.name, r.color,
              CASE r.builtin_key
                WHEN 'owner' THEN (SELECT COUNT(*) FROM users WHERE is_superadmin AND deactivated_at IS NULL)
                WHEN 'hr' THEN (SELECT COUNT(*) FROM users WHERE is_hr AND deactivated_at IS NULL)
                ELSE (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = r.id AND u.deactivated_at IS NULL)
              END AS member_count
       FROM roles r WHERE r.builtin_key IS DISTINCT FROM 'everyone' AND r.builtin_key IS DISTINCT FROM 'owner' ORDER BY r.position, r.id`
    );
    res.json({ roles: result.rows.filter((r) => roleHandle(r.name)).map((r) => ({ id: r.id, name: r.name, handle: roleHandle(r.name), color: r.color, memberCount: Number(r.member_count) })) });
  } catch (err) { sendError(res, err, 'Mentionable roles error'); }
});

// The access checker: what a person (?userId=) or a role (?roleId=) can do and see, with the reason for each answer.
// Read-only: it never acts as anyone. { subject, permissions: [{ key, label, allowed, reason }], channels: [{ id, name,
// isPrivate, member, visible, checks: { view_channel: { allowed, reason }, ... } }] }.
const CHECKED_IN_CHANNEL = ['view_channel', 'send_messages', 'attach_files', 'add_reactions'];

router.get('/check', async (req, res) => {
  try {
    await requireRoleManager(req.user.userId);
    const userId = parseId(req.query.userId);
    const roleId = parseId(req.query.roleId);
    if (!userId === !roleId) throw fail(400, 'Choose one person or one role');
    const channels = (await query('SELECT id, name, is_private FROM channels ORDER BY name')).rows;
    const label = (key) => (PERMISSIONS.find((p) => p.key === key) || {}).label || key;
    let subject;
    let permissions;
    let rows;
    if (userId) {
      const person = (await query("SELECT id, username, first_name, middle_name, last_name FROM users WHERE id = $1 AND account_type = 'member' AND deactivated_at IS NULL", [userId])).rows[0];
      if (!person) throw fail(404, 'Person not found');
      subject = { type: 'person', id: person.id, name: [person.first_name, person.middle_name, person.last_name].filter(Boolean).join(' ') || person.username };
      const workspace = await loadAccess(query, userId, null);
      permissions = PERMISSIONS.map((p) => ({ key: p.key, label: p.label, ...explainPermission(workspace, p.key) }));
      const member = new Set((await query('SELECT channel_id FROM channel_members WHERE user_id = $1', [userId])).rows.map((r) => Number(r.channel_id)));
      rows = [];
      for (const channel of channels) {
        const access = await loadAccess(query, userId, channel.id);
        const checks = {};
        for (const key of CHECKED_IN_CHANNEL) checks[key] = explainPermission(access, key);
        const isMember = member.has(Number(channel.id));
        rows.push({ id: channel.id, name: channel.name, isPrivate: channel.is_private, member: isMember, visible: access.isOwner || (isMember && checks.view_channel.allowed), checks });
      }
    } else {
      const role = (await query('SELECT id, name, permissions, builtin_key FROM roles WHERE id = $1', [roleId])).rows[0];
      if (!role) throw fail(404, 'Role not found');
      const everyone = (await query("SELECT id, name, permissions, builtin_key FROM roles WHERE builtin_key = 'everyone'")).rows[0];
      subject = { type: 'role', id: role.id, name: role.name };
      const grants = [everyone, role].filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i).map((r) => ({ key: r.builtin_key || null, name: r.name, permissions: r.permissions }));
      const isOwner = role.builtin_key === 'owner';
      permissions = PERMISSIONS.map((p) => ({ key: p.key, label: p.label, ...explainPermission({ isOwner, grants, overrides: null, channelModerator: false }, p.key) }));
      const overrides = (await query(
        "SELECT channel_id, subject_id, allow, deny FROM channel_overrides WHERE subject_type = 'role' AND subject_id = ANY($1::int[])", [[everyone.id, role.id]]
      )).rows;
      rows = channels.map((channel) => {
        const mine = overrides.filter((o) => Number(o.channel_id) === Number(channel.id));
        const forEveryone = mine.find((o) => Number(o.subject_id) === Number(everyone.id));
        const forRole = role.builtin_key === 'everyone' ? null : mine.find((o) => Number(o.subject_id) === Number(role.id));
        const state = {
          isOwner, grants, channelModerator: false,
          overrides: {
            everyone: forEveryone ? { allow: forEveryone.allow, deny: forEveryone.deny } : null,
            roles: forRole ? [{ allow: forRole.allow, deny: forRole.deny, name: role.name }] : [],
            user: null,
          },
        };
        const checks = {};
        for (const key of CHECKED_IN_CHANNEL) checks[key] = explainPermission(state, key);
        return { id: channel.id, name: channel.name, isPrivate: channel.is_private, member: null, visible: checks.view_channel.allowed, checks };
      });
    }
    res.json({ subject, permissions, channels: rows, channelPermissions: CHECKED_IN_CHANNEL.map((key) => ({ key, label: label(key) })) });
  } catch (err) { sendError(res, err, 'Access check error'); }
});

// Start "View as": a one-hour read-only token for another person, for an Owner only (it shows what their roles show them).
router.post('/view-as', async (req, res) => {
  try {
    const actor = (await query('SELECT is_superadmin FROM users WHERE id = $1 AND deactivated_at IS NULL', [req.user.userId])).rows[0];
    if (!actor || !actor.is_superadmin || req.user.viewAs) throw fail(403, 'Only an Owner can use View as');
    const userId = req.body && Number.isInteger(req.body.userId) ? req.body.userId : null;
    if (!userId) throw fail(400, 'Choose a person');
    const target = (await query(
      `SELECT id, username, email, avatar_color, is_superadmin, job_title, first_name, middle_name, last_name, token_version,
              (SELECT r.color FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = users.id ORDER BY r.position, r.id LIMIT 1) AS role_color
       FROM users WHERE id = $1 AND account_type = 'member' AND deactivated_at IS NULL`, [userId]
    )).rows[0];
    if (!target) throw fail(404, 'Person not found');
    if (target.is_superadmin) throw fail(400, 'View as is for people who are not Owners');
    const jwt = require('jsonwebtoken');
    const config = require('../config');
    const token = jwt.sign(
      { userId: target.id, username: target.username, tokenVersion: Number(target.token_version || 0), viewAs: req.user.userId },
      config.JWT_SECRET, { expiresIn: `${VIEW_AS_MINUTES}m` }
    );
    await audit(req.user.userId, 'view_as_started', target.id, { minutes: VIEW_AS_MINUTES });
    res.json({
      token,
      expiresAt: new Date(Date.now() + VIEW_AS_MINUTES * 60000).toISOString(),
      user: {
        id: target.id, username: target.username, email: target.email, avatarColor: target.avatar_color, isSuperadmin: false,
        jobTitle: target.job_title || '', firstName: target.first_name || '', middleName: target.middle_name || '',
        lastName: target.last_name || '', roleColor: target.role_color || null, mustChangePassword: false,
      },
    });
  } catch (err) { sendError(res, err, 'View as error'); }
});

router.get('/permissions', async (req, res) => {
  try {
    await requireRoleManager(req.user.userId);
    res.json({ permissions: PERMISSIONS });
  } catch (err) { sendError(res, err, 'Permissions list error'); }
});

router.get('/', async (req, res) => {
  try {
    const actor = await requireRoleManager(req.user.userId);
    const result = await query(
      `SELECT r.id, r.name, r.color, r.position, r.permissions, r.builtin_key,
              CASE r.builtin_key
                WHEN 'owner' THEN (SELECT COUNT(*) FROM users WHERE is_superadmin AND deactivated_at IS NULL)
                WHEN 'hr' THEN (SELECT COUNT(*) FROM users WHERE is_hr AND deactivated_at IS NULL)
                WHEN 'everyone' THEN (SELECT COUNT(*) FROM users WHERE account_type = 'member' AND deactivated_at IS NULL)
                ELSE (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = r.id AND u.deactivated_at IS NULL)
              END AS member_count
       FROM roles r ORDER BY r.position, r.id`
    );
    res.json({ roles: result.rows.map((row) => mapRole(row, actor)) });
  } catch (err) { sendError(res, err, 'List roles error'); }
});

router.post('/', async (req, res) => {
  try {
    const actor = await requireRoleManager(req.user.userId);
    const clean = cleanRoleInput(req.body);
    if (clean.error) throw fail(400, clean.error);
    const blocked = ungrantable(actor, clean.permissions);
    if (blocked.length) throw fail(403, `You cannot give a permission you do not have: ${blocked.join(', ')}`);
    const count = (await query('SELECT COUNT(*)::int AS n FROM roles WHERE builtin_key IS NULL')).rows[0].n;
    if (count >= MAX_CUSTOM_ROLES) throw fail(400, `A workspace can have up to ${MAX_CUSTOM_ROLES} custom roles`);
    if ((await query('SELECT 1 FROM roles WHERE LOWER(name) = LOWER($1)', [clean.name])).rows.length) throw fail(409, 'A role with that name already exists');
    // a new role ranks just below the person making it (never above HR for an Owner)
    const position = Math.max(20, Number.isFinite(actor.rank) ? actor.rank + 1 : 20);
    const bottom = (await query("SELECT COALESCE(MAX(position), 0) AS p FROM roles WHERE builtin_key IS NULL AND position >= $1", [position])).rows[0].p;
    const placed = Math.min(900, Math.max(position, Number(bottom) + 10));
    const created = (await query(
      'INSERT INTO roles (name, color, position, permissions, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [clean.name, clean.color, placed, clean.permissions, req.user.userId]
    )).rows[0];
    await audit(req.user.userId, 'role_created', null, { roleId: created.id, name: clean.name, permissions: clean.permissions });
    res.status(201).json({ role: mapRole({ ...(await roleById(created.id)), member_count: 0 }, actor) });
  } catch (err) { sendError(res, err, 'Create role error'); }
});

router.put('/:id', async (req, res) => {
  try {
    const actor = await requireRoleManager(req.user.userId);
    const role = await roleById(parseId(req.params.id));
    if (!role) throw fail(404, 'Role not found');
    if (!canManageRole(actor, role)) throw fail(403, 'You cannot change a role at or above your own');
    const clean = cleanRoleInput(req.body, role);
    if (clean.error) throw fail(400, clean.error);
    // you may keep what the role has, but only add permissions you hold yourself
    const added = clean.permissions.filter((key) => !role.permissions.includes(key));
    const blocked = ungrantable(actor, added);
    if (blocked.length) throw fail(403, `You cannot give a permission you do not have: ${blocked.join(', ')}`);
    if (clean.name.toLowerCase() !== role.name.toLowerCase()
      && (await query('SELECT 1 FROM roles WHERE LOWER(name) = LOWER($1) AND id <> $2', [clean.name, role.id])).rows.length) {
      throw fail(409, 'A role with that name already exists');
    }
    await query('UPDATE roles SET name = $1, color = $2, permissions = $3 WHERE id = $4', [clean.name, clean.color, clean.permissions, role.id]);
    await audit(req.user.userId, 'role_updated', null, { roleId: role.id, name: clean.name, before: role.permissions, after: clean.permissions });
    res.json({ role: mapRole({ ...(await roleById(role.id)), member_count: 0 }, actor) });
  } catch (err) { sendError(res, err, 'Update role error'); }
});

router.delete('/:id', async (req, res) => {
  try {
    const actor = await requireRoleManager(req.user.userId);
    const role = await roleById(parseId(req.params.id));
    if (!role) throw fail(404, 'Role not found');
    if (role.builtin_key) throw fail(400, 'Built-in roles cannot be deleted');
    if (!canManageRole(actor, role)) throw fail(403, 'You cannot delete a role at or above your own');
    await query('DELETE FROM roles WHERE id = $1', [role.id]); // assignments and channel overrides for it go with it
    await query("DELETE FROM channel_overrides WHERE subject_type = 'role' AND subject_id = $1", [role.id]);
    await audit(req.user.userId, 'role_deleted', null, { roleId: role.id, name: role.name });
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Delete role error'); }
});

// Move a custom role one place up or down among the custom roles you may manage.
router.put('/:id/move', async (req, res) => {
  try {
    const actor = await requireRoleManager(req.user.userId);
    const role = await roleById(parseId(req.params.id));
    if (!role) throw fail(404, 'Role not found');
    if (role.builtin_key) throw fail(400, 'Built-in roles keep their place');
    if (!canManageRole(actor, role)) throw fail(403, 'You cannot move a role at or above your own');
    const direction = req.body && req.body.direction;
    if (!['up', 'down'].includes(direction)) throw fail(400, 'direction must be up or down');
    const neighbor = (await query(
      direction === 'up'
        ? 'SELECT id, position FROM roles WHERE builtin_key IS NULL AND position < $1 ORDER BY position DESC LIMIT 1'
        : 'SELECT id, position FROM roles WHERE builtin_key IS NULL AND position > $1 ORDER BY position ASC LIMIT 1',
      [role.position]
    )).rows[0];
    if (!neighbor) return res.json({ ok: true });
    if (!canManageRole(actor, { ...neighbor, builtin_key: null })) throw fail(403, 'You cannot move a role above your own');
    await query('UPDATE roles SET position = CASE id WHEN $1::int THEN $3::int WHEN $2::int THEN $4::int END WHERE id IN ($1::int, $2::int)', [role.id, neighbor.id, neighbor.position, role.position]);
    await audit(req.user.userId, 'role_moved', null, { roleId: role.id, direction });
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Move role error'); }
});

// Replace the custom roles someone holds. Roles you may not manage stay as they were.
router.put('/users/:userId', async (req, res) => {
  try {
    const actor = await requireRoleManager(req.user.userId);
    const userId = parseId(req.params.userId);
    const wanted = req.body && req.body.roleIds;
    if (!userId || !Array.isArray(wanted) || wanted.some((id) => !Number.isInteger(id))) throw fail(400, 'roleIds must be a list of role ids');
    const person = (await query("SELECT id, account_type FROM users WHERE id = $1 AND deactivated_at IS NULL", [userId])).rows[0];
    if (!person || person.account_type !== 'member') throw fail(404, 'Person not found');
    const custom = (await query('SELECT id, position, builtin_key FROM roles WHERE builtin_key IS NULL')).rows;
    const byId = new Map(custom.map((r) => [r.id, r]));
    if (wanted.some((id) => !byId.has(id))) throw fail(400, 'Unknown role');
    const held = new Set((await query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId])).rows.map((r) => r.role_id));
    const want = new Set(wanted);
    const toAdd = [...want].filter((id) => !held.has(id));
    const toRemove = [...held].filter((id) => !want.has(id));
    for (const id of [...toAdd, ...toRemove]) {
      if (!canManageRole(actor, byId.get(id))) throw fail(403, 'You cannot give or take a role at or above your own');
    }
    for (const id of toAdd) await query('INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [userId, id, req.user.userId]);
    for (const id of toRemove) await query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, id]);
    if (toAdd.length || toRemove.length) await audit(req.user.userId, 'roles_assigned', userId, { added: toAdd, removed: toRemove });
    if (req.io) req.io.emit('permissions_updated', { userId, byUserId: req.user.userId });
    res.json({ roleIds: [...want] });
  } catch (err) { sendError(res, err, 'Assign roles error'); }
});

// Everyone's custom roles at once, for the assignment table: { assignments: { userId: [roleId] }, owners: [id], hr: [id] }.
router.get('/assignments', async (req, res) => {
  try {
    await requireRoleManager(req.user.userId);
    const held = (await query('SELECT user_id, role_id FROM user_roles')).rows;
    const assignments = {};
    for (const row of held) (assignments[row.user_id] = assignments[row.user_id] || []).push(row.role_id);
    const flags = (await query("SELECT id, is_superadmin, is_hr FROM users WHERE account_type = 'member' AND deactivated_at IS NULL")).rows;
    res.json({ assignments, owners: flags.filter((u) => u.is_superadmin).map((u) => u.id), hr: flags.filter((u) => u.is_hr).map((u) => u.id) });
  } catch (err) { sendError(res, err, 'Role assignments error'); }
});

// The custom roles someone holds (for the person's record).
router.get('/users/:userId', async (req, res) => {
  try {
    await requireRoleManager(req.user.userId);
    const userId = parseId(req.params.userId);
    if (!userId) throw fail(400, 'A valid person is required');
    const result = await query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId]);
    res.json({ roleIds: result.rows.map((r) => r.role_id) });
  } catch (err) { sendError(res, err, 'Person roles error'); }
});

module.exports = router;
