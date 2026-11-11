const express = require('express');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureDirectMessageAccess } = require('../security');

// Get all users (for DM list, etc.)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, username, email, avatar_color, status, last_seen, created_at,
              status_text, status_emoji, dnd_until, account_type, job_title
       FROM users
       WHERE id != $1
         AND account_type <> 'bot'
         AND (
           NOT EXISTS (SELECT 1 FROM users me WHERE me.id = $1 AND me.account_type = 'guest')
           OR EXISTS (
             SELECT 1 FROM channel_members mine
             JOIN channel_members theirs ON theirs.channel_id = mine.channel_id
             WHERE mine.user_id = $1 AND theirs.user_id = users.id
           )
         )
       ORDER BY username`,
      [req.user.userId]
    );

    res.json({
      users: result.rows.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        avatarColor: u.avatar_color,
        status: u.status,
        lastSeen: u.last_seen,
        createdAt: u.created_at,
        statusText: u.status_text || '',
        statusEmoji: u.status_emoji || '',
        accountType: u.account_type || 'member',
        jobTitle: u.job_title || '',
        dndUntil: u.dnd_until && new Date(u.dnd_until) > new Date() ? u.dnd_until : null,
      })),
    });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Heartbeat: client pings to stay "online" and refresh last_seen
router.post('/heartbeat', authenticateToken, async (req, res) => {
  try {
    await query(
      'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
      ['online', req.user.userId]
    );
    res.json({ status: 'online', timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user by ID
router.get('/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await query(
      'SELECT id, username, email, avatar_color, status, last_seen, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const u = result.rows[0];
    res.json({
      user: {
        id: u.id,
        username: u.username,
        email: u.email,
        avatarColor: u.avatar_color,
        status: u.status,
        lastSeen: u.last_seen,
        createdAt: u.created_at,
      },
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get direct messages between current user and another user
router.get('/:userId/direct-messages', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    await ensureDirectMessageAccess(query, req.user.userId, userId);

    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);

    const result = await query(`
      SELECT dm.id, dm.sender_id, dm.receiver_id, dm.content, dm.created_at,
             u.username, u.avatar_color
      FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE (dm.sender_id = $1 AND dm.receiver_id = $2)
         OR (dm.sender_id = $2 AND dm.receiver_id = $1)
      ORDER BY dm.created_at DESC, dm.id DESC
      LIMIT $3 OFFSET $4
    `, [req.user.userId, userId, limit, offset]);

    // Fetch attachments for these direct messages
    const dmIds = result.rows.map((m) => m.id);
    let attachmentsByDm = {};
    if (dmIds.length > 0) {
      const fileResult = await query(
        `SELECT id, dm_message_id, filename, original_name, size, mime_type, uploaded_by
         FROM files WHERE dm_message_id = ANY($1)`,
        [dmIds]
      );
      fileResult.rows.forEach((f) => {
        if (!attachmentsByDm[f.dm_message_id]) {
          attachmentsByDm[f.dm_message_id] = [];
        }
        attachmentsByDm[f.dm_message_id].push({
          id: f.id,
          filename: f.original_name,
          size: f.size,
          mimeType: f.mime_type,
          uploadedBy: f.uploaded_by,
        });
      });
    }

    res.json({
      messages: result.rows.reverse().map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        receiverId: m.receiver_id,
        content: m.content,
        createdAt: m.created_at,
        senderUsername: m.username,
        senderAvatarColor: m.avatar_color,
        attachments: attachmentsByDm[m.id] || [],
      })),
    });
  } catch (err) {
    console.error('Get direct messages error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

router.get('/:userId/direct-messages/context/:messageId', authenticateToken, async (req, res) => {
  try {
    const { userId, messageId } = req.params;
    await ensureDirectMessageAccess(query, req.user.userId, userId);

    const target = await query(
      `SELECT id, created_at
       FROM direct_messages
       WHERE id = $1 AND (
         (sender_id = $2 AND receiver_id = $3)
         OR (sender_id = $3 AND receiver_id = $2)
       )`,
      [messageId, req.user.userId, userId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'Direct message not found' });
    }

    const position = await query(
      `SELECT COUNT(*)::int AS newer_count
       FROM direct_messages
       WHERE (
         (sender_id = $1 AND receiver_id = $2)
         OR (sender_id = $2 AND receiver_id = $1)
       )
         AND (created_at, id) > ($3, $4)`,
      [req.user.userId, userId, target.rows[0].created_at, target.rows[0].id]
    );

    res.json({ offset: Math.floor(position.rows[0].newer_count / 100) * 100 });
  } catch (err) {
    console.error('Get direct message context error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

module.exports = router;
