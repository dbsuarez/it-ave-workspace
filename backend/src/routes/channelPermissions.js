// Channel overrides: GET /api/channels/:channelId/permissions and PUT (one role or person at a time).
// Who may change them: an Owner, a role with manage_channels, or the person who created the channel.
// Each key is allow, deny or inherit (absent). See docs/ROLES_DESIGN.md for how overrides combine.
const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { can } = require('../permissions');

const router = express.Router();
router.use(authenticateToken);

// The permissions a channel can override (the ones enforced per channel).
const CHANNEL_PERMISSIONS = [
  { key: 'view_channel', label: 'See the channel and read it' },
  { key: 'send_messages', label: 'Send messages' },
  { key: 'attach_files', label: 'Attach files' },
  { key: 'add_reactions', label: 'Add reactions' },
];
const CHANNEL_KEYS = CHANNEL_PERMISSIONS.map((p) => p.key);

const fail = (status, message) => Object.assign(new Error(message), { status });
const parseId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function requireChannelManager(userId, channelId) {
  const channel = (await query('SELECT id, name, created_by FROM channels WHERE id = $1', [channelId])).rows[0];
  if (!channel) throw fail(404, 'Channel not found');
  const allowed = Number(channel.created_by) === Number(userId) || await can(query, userId, 'manage_channels');
  if (!allowed) throw fail(403, 'Only the channel creator or someone who manages channels can change its permissions');
  return channel;
}

router.get('/:channelId/permissions', async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    if (!channelId) throw fail(400, 'A valid channel is required');
    await requireChannelManager(req.user.userId, channelId);
    const roles = (await query(
      `SELECT r.id, r.name, r.color, r.builtin_key, r.permissions, COALESCE(co.allow, '{}') AS allow, COALESCE(co.deny, '{}') AS deny
       FROM roles r
       LEFT JOIN channel_overrides co ON co.channel_id = $1 AND co.subject_type = 'role' AND co.subject_id = r.id
       WHERE r.builtin_key IS DISTINCT FROM 'owner'
       ORDER BY r.position, r.id`, [channelId]
    )).rows;
    const people = (await query(
      `SELECT u.id, u.username, u.first_name, u.middle_name, u.last_name, co.allow, co.deny
       FROM channel_overrides co JOIN users u ON u.id = co.subject_id
       WHERE co.channel_id = $1 AND co.subject_type = 'user' ORDER BY LOWER(u.username)`, [channelId]
    )).rows;
    res.json({
      permissions: CHANNEL_PERMISSIONS,
      roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.color, builtin: r.builtin_key || null, grants: r.permissions, allow: r.allow, deny: r.deny })),
      people: people.map((p) => ({
        id: p.id, username: p.username, allow: p.allow, deny: p.deny,
        name: [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ') || p.username,
      })),
    });
  } catch (err) { sendError(res, err, 'Get channel permissions error'); }
});

// { subjectType: 'role' | 'user', subjectId, allow: [...], deny: [...] } - both empty removes the override.
router.put('/:channelId/permissions', async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    if (!channelId) throw fail(400, 'A valid channel is required');
    const channel = await requireChannelManager(req.user.userId, channelId);
    const { subjectType, subjectId } = req.body || {};
    const allow = req.body && req.body.allow;
    const deny = req.body && req.body.deny;
    if (!['role', 'user'].includes(subjectType) || !Number.isInteger(subjectId)) throw fail(400, 'Choose a role or a person');
    if (![allow, deny].every((list) => Array.isArray(list) && list.every((key) => CHANNEL_KEYS.includes(key)))) throw fail(400, 'Unknown permission');
    if (allow.some((key) => deny.includes(key))) throw fail(400, 'A permission cannot be both allowed and denied');
    if (subjectType === 'role') {
      const role = (await query('SELECT builtin_key FROM roles WHERE id = $1', [subjectId])).rows[0];
      if (!role) throw fail(404, 'Role not found');
      if (role.builtin_key === 'owner') throw fail(400, 'Owners always have every permission');
    } else if (!(await query("SELECT 1 FROM users WHERE id = $1 AND account_type = 'member'", [subjectId])).rows.length) {
      throw fail(404, 'Person not found');
    }
    if (!allow.length && !deny.length) {
      await query('DELETE FROM channel_overrides WHERE channel_id = $1 AND subject_type = $2 AND subject_id = $3', [channelId, subjectType, subjectId]);
    } else {
      await query(
        `INSERT INTO channel_overrides (channel_id, subject_type, subject_id, allow, deny) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, subject_type, subject_id) DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
        [channelId, subjectType, subjectId, allow, deny]
      );
    }
    await query(
      'INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details) VALUES ($1, $2, $3, $4, $5)',
      [channelId, req.user.userId, subjectType === 'user' ? subjectId : null, 'channel_permissions_changed', JSON.stringify({ channel: channel.name, subjectType, subjectId, allow, deny })]
    );
    if (req.io) req.io.emit('permissions_updated', { channelId });
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Set channel permissions error'); }
});

module.exports = router;
