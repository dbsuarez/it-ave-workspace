const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');

// Named groups of people that can be mentioned together, e.g. @support.
// Everyone can see groups; Superadmins manage them.
const router = express.Router();
router.use(authenticateToken);

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(400).json({ error: 'A group with that handle already exists' });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function requireSuperadmin(req) {
  const result = await query('SELECT is_superadmin FROM users WHERE id = $1', [req.user.userId]);
  if (!result.rows[0]?.is_superadmin) throw fail(403, 'Superadmin access required');
}

function isValidGroupHandle(handle) {
  return typeof handle === 'string' && HANDLE_PATTERN.test(handle);
}

async function loadGroups(groupId = null) {
  const groups = await query(
    `SELECT id, handle, name, created_at FROM user_groups
     WHERE $1::int IS NULL OR id = $1
     ORDER BY handle`,
    [groupId]
  );
  const members = await query(
    `SELECT ugm.group_id, u.id, u.username
     FROM user_group_members ugm JOIN users u ON u.id = ugm.user_id
     WHERE $1::int IS NULL OR ugm.group_id = $1
     ORDER BY LOWER(u.username)`,
    [groupId]
  );
  return groups.rows.map((group) => ({
    id: group.id,
    handle: group.handle,
    name: group.name,
    createdAt: group.created_at,
    members: members.rows
      .filter((member) => member.group_id === group.id)
      .map((member) => ({ id: member.id, username: member.username })),
  }));
}

router.get('/', async (req, res) => {
  try {
    res.json({ groups: await loadGroups() });
  } catch (err) {
    sendError(res, err, 'List user groups error');
  }
});

router.post('/', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim().toLowerCase() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!isValidGroupHandle(handle)) {
      throw fail(400, 'Handle must be 2 to 31 characters: lowercase letters, numbers, and hyphens');
    }
    if (name.length > 80) throw fail(400, 'Name must be 80 characters or fewer');
    const clash = await query('SELECT 1 FROM users WHERE LOWER(username) = $1', [handle]);
    if (clash.rows.length) throw fail(400, 'That handle is already someone\'s username');
    const created = await query(
      'INSERT INTO user_groups (handle, name, created_by) VALUES ($1, $2, $3) RETURNING id',
      [handle, name || handle, req.user.userId]
    );
    const [group] = await loadGroups(created.rows[0].id);
    req.io?.emit('user_groups_updated');
    res.status(201).json({ group });
  } catch (err) {
    sendError(res, err, 'Create user group error');
  }
});

router.delete('/:groupId', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const groupId = parseId(req.params.groupId);
    if (!groupId) throw fail(400, 'A valid group ID is required');
    const removed = await query('DELETE FROM user_groups WHERE id = $1 RETURNING id', [groupId]);
    if (!removed.rows.length) throw fail(404, 'Group not found');
    req.io?.emit('user_groups_updated');
    res.json({ removed: true });
  } catch (err) {
    sendError(res, err, 'Delete user group error');
  }
});

router.put('/:groupId/members/:userId', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const groupId = parseId(req.params.groupId);
    const userId = parseId(req.params.userId);
    if (!groupId || !userId) throw fail(400, 'Valid group and user IDs are required');
    const added = await query(
      `INSERT INTO user_group_members (group_id, user_id)
       SELECT g.id, u.id FROM user_groups g CROSS JOIN users u
       WHERE g.id = $1 AND u.id = $2 AND u.account_type <> 'bot'
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [groupId, userId]
    );
    if (!added.rows.length) {
      const exists = await query(
        'SELECT 1 FROM user_group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, userId]
      );
      if (!exists.rows.length) throw fail(404, 'Group or user not found');
    }
    const [group] = await loadGroups(groupId);
    req.io?.emit('user_groups_updated');
    res.json({ group });
  } catch (err) {
    sendError(res, err, 'Add user group member error');
  }
});

router.delete('/:groupId/members/:userId', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const groupId = parseId(req.params.groupId);
    const userId = parseId(req.params.userId);
    if (!groupId || !userId) throw fail(400, 'Valid group and user IDs are required');
    const removed = await query(
      'DELETE FROM user_group_members WHERE group_id = $1 AND user_id = $2 RETURNING user_id',
      [groupId, userId]
    );
    if (!removed.rows.length) throw fail(404, 'That person is not in this group');
    const [group] = await loadGroups(groupId);
    req.io?.emit('user_groups_updated');
    res.json({ group });
  } catch (err) {
    sendError(res, err, 'Remove user group member error');
  }
});

module.exports = router;
module.exports.isValidGroupHandle = isValidGroupHandle;
