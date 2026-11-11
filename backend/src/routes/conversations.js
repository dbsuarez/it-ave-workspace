const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureNotGuest } = require('../guests');

// Group direct messages: a private conversation between three or more people.
const router = express.Router();
router.use(authenticateToken);

const MAX_MEMBERS = 9;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function ensureConversationMember(userId, conversationId) {
  if (!conversationId) throw fail(400, 'A valid conversation ID is required');
  const result = await query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  if (!result.rows.length) throw fail(403, 'Access denied');
}

async function loadConversation(conversationId, viewerId) {
  const [conversation, members, unread] = await Promise.all([
    query('SELECT id, name, created_by, created_at FROM conversations WHERE id = $1', [conversationId]),
    query(
      `SELECT u.id, u.username, u.avatar_color, u.status
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = $1
       ORDER BY LOWER(u.username)`,
      [conversationId]
    ),
    query(
      `SELECT COUNT(*)::int AS count
       FROM conversation_messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
       WHERE m.conversation_id = $1 AND m.user_id <> $2
         AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)`,
      [conversationId, viewerId]
    ),
  ]);
  if (!conversation.rows.length) return null;
  const row = conversation.rows[0];
  return {
    id: row.id,
    name: row.name || '',
    createdBy: row.created_by,
    createdAt: row.created_at,
    unreadCount: unread.rows[0]?.count || 0,
    members: members.rows.map((member) => ({
      id: member.id,
      username: member.username,
      avatarColor: member.avatar_color,
      status: member.status,
    })),
  };
}

async function memberIds(conversationId) {
  const result = await query(
    'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
    [conversationId]
  );
  return result.rows.map((row) => row.user_id);
}

function emitToUsers(io, userIds, event, payload) {
  if (!io) return;
  userIds.forEach((userId) => io.to(`user_${userId}`).emit(event, payload));
}

function validateName(name) {
  if (name === undefined || name === null) return '';
  if (typeof name !== 'string' || name.trim().length > 80) {
    throw fail(400, 'Group name must be 80 characters or fewer');
  }
  return name.trim();
}

// List the caller's group conversations, most recently active first.
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
       ORDER BY COALESCE(
         (SELECT MAX(created_at) FROM conversation_messages m WHERE m.conversation_id = c.id),
         c.created_at
       ) DESC`,
      [req.user.userId]
    );
    const conversations = [];
    for (const row of result.rows) {
      conversations.push(await loadConversation(row.id, req.user.userId));
    }
    res.json({ conversations: conversations.filter(Boolean) });
  } catch (err) {
    sendError(res, err, 'List conversations error');
  }
});

// Create a group conversation with at least two other people.
router.post('/', async (req, res) => {
  try {
    const { memberIds: requested, name } = req.body || {};
    await ensureNotGuest(query, req.user.userId, 'Guests cannot start group messages');
    const groupName = validateName(name);
    if (!Array.isArray(requested)) throw fail(400, 'memberIds must be a list of user IDs');
    const others = [...new Set(requested.map(parseId))]
      .filter((id) => id && id !== Number(req.user.userId));
    if (others.length !== new Set(requested).size - (requested.map(Number).includes(Number(req.user.userId)) ? 1 : 0)) {
      throw fail(400, 'memberIds must be valid user IDs');
    }
    if (others.length < 2) throw fail(400, 'A group message needs at least two other people');
    if (others.length + 1 > MAX_MEMBERS) throw fail(400, `A group message can have at most ${MAX_MEMBERS} people`);

    const existing = await query('SELECT id FROM users WHERE id = ANY($1)', [others]);
    if (existing.rows.length !== others.length) throw fail(404, 'One or more users were not found');

    const created = await query(
      'INSERT INTO conversations (name, created_by) VALUES ($1, $2) RETURNING id',
      [groupName, req.user.userId]
    );
    const conversationId = created.rows[0].id;
    const everyone = [Number(req.user.userId), ...others];
    await query(
      `INSERT INTO conversation_members (conversation_id, user_id)
       SELECT $1, UNNEST($2::int[])`,
      [conversationId, everyone]
    );

    for (const userId of everyone) {
      emitToUsers(req.io, [userId], 'conversation_updated', {
        conversation: await loadConversation(conversationId, userId),
      });
    }
    res.status(201).json({ conversation: await loadConversation(conversationId, req.user.userId) });
  } catch (err) {
    sendError(res, err, 'Create conversation error');
  }
});

// Message history, oldest first.
router.get('/:conversationId/messages', async (req, res) => {
  try {
    const conversationId = parseId(req.params.conversationId);
    await ensureConversationMember(req.user.userId, conversationId);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const result = await query(
      `SELECT m.id, m.conversation_id, m.user_id, m.content, m.created_at,
              u.username, u.avatar_color
       FROM conversation_messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset]
    );
    res.json({
      messages: result.rows.reverse().map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        senderId: row.user_id,
        senderUsername: row.username,
        senderAvatarColor: row.avatar_color,
        content: row.content,
        createdAt: row.created_at,
        attachments: [],
      })),
    });
  } catch (err) {
    sendError(res, err, 'Get conversation messages error');
  }
});

router.post('/:conversationId/read', async (req, res) => {
  try {
    const conversationId = parseId(req.params.conversationId);
    await ensureConversationMember(req.user.userId, conversationId);
    await query(
      'UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, req.user.userId]
    );
    res.json({ read: true });
  } catch (err) {
    sendError(res, err, 'Mark conversation read error');
  }
});

// Rename the group (any member).
router.patch('/:conversationId', async (req, res) => {
  try {
    const conversationId = parseId(req.params.conversationId);
    await ensureConversationMember(req.user.userId, conversationId);
    const groupName = validateName(req.body?.name);
    await query('UPDATE conversations SET name = $1 WHERE id = $2', [groupName, conversationId]);
    for (const userId of await memberIds(conversationId)) {
      emitToUsers(req.io, [userId], 'conversation_updated', {
        conversation: await loadConversation(conversationId, userId),
      });
    }
    res.json({ conversation: await loadConversation(conversationId, req.user.userId) });
  } catch (err) {
    sendError(res, err, 'Rename conversation error');
  }
});

// Add a person (any member can add).
router.post('/:conversationId/members', async (req, res) => {
  try {
    const conversationId = parseId(req.params.conversationId);
    await ensureConversationMember(req.user.userId, conversationId);
    const userId = parseId(req.body?.userId);
    if (!userId) throw fail(400, 'A valid user ID is required');
    const user = await query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!user.rows.length) throw fail(404, 'User not found');
    const current = await memberIds(conversationId);
    if (current.map(Number).includes(userId)) throw fail(409, 'That person is already in this group');
    if (current.length >= MAX_MEMBERS) throw fail(400, `A group message can have at most ${MAX_MEMBERS} people`);

    await query(
      'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)',
      [conversationId, userId]
    );
    for (const memberId of [...current, userId]) {
      emitToUsers(req.io, [memberId], 'conversation_updated', {
        conversation: await loadConversation(conversationId, memberId),
      });
    }
    res.status(201).json({ conversation: await loadConversation(conversationId, req.user.userId) });
  } catch (err) {
    sendError(res, err, 'Add conversation member error');
  }
});

// Leave the group, or (creator only) remove someone else.
router.delete('/:conversationId/members/:userId', async (req, res) => {
  try {
    const conversationId = parseId(req.params.conversationId);
    const userId = parseId(req.params.userId);
    await ensureConversationMember(req.user.userId, conversationId);
    if (!userId) throw fail(400, 'A valid user ID is required');
    if (userId !== Number(req.user.userId)) {
      const conversation = await query('SELECT created_by FROM conversations WHERE id = $1', [conversationId]);
      if (Number(conversation.rows[0]?.created_by) !== Number(req.user.userId)) {
        throw fail(403, 'Only the person who created the group can remove others');
      }
    }
    const removed = await query(
      'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 RETURNING user_id',
      [conversationId, userId]
    );
    if (!removed.rows.length) throw fail(404, 'That person is not in this group');

    emitToUsers(req.io, [userId], 'conversation_removed', { conversationId });
    const remaining = await memberIds(conversationId);
    if (remaining.length === 0) {
      await query('DELETE FROM conversations WHERE id = $1', [conversationId]);
    } else {
      for (const memberId of remaining) {
        emitToUsers(req.io, [memberId], 'conversation_updated', {
          conversation: await loadConversation(conversationId, memberId),
        });
      }
    }
    res.json({ removed: true });
  } catch (err) {
    sendError(res, err, 'Remove conversation member error');
  }
});

module.exports = router;
module.exports.ensureConversationMember = ensureConversationMember;
module.exports.memberIds = memberIds;
