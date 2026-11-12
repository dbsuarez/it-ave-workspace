const express = require('express');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership } = require('../security');
const { viewableChannels } = require('../permissions');
const { ensureNotGuest } = require('../guests');

// Get all channels (with member count)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT c.id, c.name, c.topic, c.is_private, c.created_at, c.created_by,
             COUNT(cm.user_id)::int AS member_count
      FROM channels c
      LEFT JOIN channel_members cm ON c.id = cm.channel_id
      WHERE (c.is_private = FALSE AND NOT EXISTS (
        SELECT 1 FROM users g WHERE g.id = $1 AND g.account_type = 'guest'
      )) OR EXISTS (
        SELECT 1 FROM channel_members mine
        WHERE mine.channel_id = c.id AND mine.user_id = $1
      ) OR EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND u.is_superadmin = TRUE)
      GROUP BY c.id
      ORDER BY c.name
    `, [req.user.userId]);

    res.json({
      channels: (await viewableChannels(query, req.user.userId, result.rows)).map((ch) => ({
        id: ch.id,
        name: ch.name,
        topic: ch.topic,
        isPrivate: ch.is_private,
        memberCount: ch.member_count,
        createdAt: ch.created_at,
        createdBy: ch.created_by,
      })),
    });
  } catch (err) {
    console.error('Get channels error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get channels the current user is a member of (with unread count)
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT c.id, c.name, c.topic, c.is_private, c.created_at, c.created_by,
             COUNT(DISTINCT cm2.user_id)::int AS member_count,
             COUNT(DISTINCT m.id)::int AS unread_count
      FROM channels c
      LEFT JOIN channel_members cm ON c.id = cm.channel_id
      LEFT JOIN channel_members cm2 ON c.id = cm2.channel_id
      LEFT JOIN messages m
        ON m.channel_id = c.id
       AND m.created_at > COALESCE(
             (SELECT read_at FROM channel_read_at
              WHERE channel_id = c.id AND user_id = $1),
             '-infinity'::timestamptz
           )
       AND m.user_id != $1
      WHERE cm.user_id = $1 OR EXISTS (
        SELECT 1 FROM users u WHERE u.id = $1 AND u.is_superadmin = TRUE
      )
      GROUP BY c.id
      ORDER BY c.name
    `, [req.user.userId]);

    res.json({
      channels: (await viewableChannels(query, req.user.userId, result.rows)).map((ch) => ({
        id: ch.id,
        name: ch.name,
        topic: ch.topic,
        isPrivate: ch.is_private,
        memberCount: ch.member_count,
        createdAt: ch.created_at,
        createdBy: ch.created_by,
        unreadCount: ch.unread_count || 0,
      })),
    });
  } catch (err) {
    console.error('Get my channels error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit channel topic (Superadmin, channel creator, or channel moderator only)
router.patch('/:channelId', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { topic } = req.body;

    if (topic === undefined || typeof topic !== 'string') {
      return res.status(400).json({ error: 'Topic is required and must be a string' });
    }
    if (topic.length > 250) {
      return res.status(400).json({ error: 'Topic must be 250 characters or fewer' });
    }

    await ensureChannelMembership(query, req.user.userId, channelId);
    await ensureNotGuest(query, req.user.userId, 'Guests cannot edit channels');

    // Editing the description is reserved for: Superadmin, the channel creator,
    // or a channel moderator.
    const permission = await query(
      `SELECT 1 FROM channels c
       JOIN users u ON u.id = $2
       WHERE c.id = $1 AND (
         u.is_superadmin = TRUE
         OR c.created_by = u.id
         OR EXISTS (
           SELECT 1 FROM channel_members cm
           WHERE cm.channel_id = $1 AND cm.user_id = u.id AND cm.role = 'moderator'
         )
       )`,
      [channelId, req.user.userId]
    );

    if (permission.rows.length === 0) {
      return res.status(403).json({ error: 'Only the channel creator, a channel moderator or the Superadmin can edit the channel description' });
    }

    const result = await query(
      `UPDATE channels SET topic = $1 WHERE id = $2 RETURNING id, name, topic, is_private, created_at`,
      [topic.trim(), channelId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const channel = result.rows[0];

    // Notify everyone viewing the channel so their header and sidebar update live
    req.io?.to(`channel_${channelId}`).emit('channel_topic_updated', {
      channelId: Number(channelId),
      topic: channel.topic,
    });

    res.json({
      channel: {
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
        isPrivate: channel.is_private,
        createdAt: channel.created_at,
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Update channel error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
});

// Create a new channel
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, topic, isPrivate } = req.body;
    await ensureNotGuest(query, req.user.userId, 'Guests cannot create channels');

    if (!name) {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    // Validate channel name (lowercase, alphanumeric, hyphens)
    if (!/^[a-z0-9-]+$/.test(name)) {
      return res.status(400).json({ error: 'Channel name must be lowercase letters, numbers, and hyphens only' });
    }

    // a new channel starts with the workspace's default slow mode (5 seconds unless the Superadmin changed it)
    const policy = await query('SELECT default_slowmode_seconds FROM moderation_settings WHERE id = 1');
    const slowmode = policy.rows[0] && Number.isInteger(policy.rows[0].default_slowmode_seconds) ? policy.rows[0].default_slowmode_seconds : 5;
    const result = await query(
      `INSERT INTO channels (name, topic, is_private, created_by, slowmode_seconds) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, name, topic, is_private, created_at`,
      [name, topic || '', isPrivate || false, req.user.userId, slowmode]
    );

    const channel = result.rows[0];

    // Add creator as member
    await query(
      "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'moderator')",
      [channel.id, req.user.userId]
    );

    res.status(201).json({
      message: 'Channel created successfully',
      channel: {
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
        isPrivate: channel.is_private,
        createdAt: channel.created_at,
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Create channel error:', err);
    if (err.code === '23505') { // unique violation
      return res.status(400).json({ error: 'Channel name already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Get channel details by ID
router.get('/:channelId', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;

    await ensureChannelMembership(query, req.user.userId, channelId);

    const result = await query(
      `SELECT c.id, c.name, c.topic, c.is_private, c.created_at,
             COUNT(cm.user_id)::int AS member_count
      FROM channels c
      LEFT JOIN channel_members cm ON c.id = cm.channel_id
      WHERE c.id = $1
      GROUP BY c.id`,
      [channelId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const channel = result.rows[0];
    res.json({
      channel: {
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
        isPrivate: channel.is_private,
        memberCount: channel.member_count,
        createdAt: channel.created_at,
      },
    });
  } catch (err) {
    console.error('Get channel error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

// List the members of a channel (used for @mention suggestions)
router.get('/:channelId/members', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    await ensureChannelMembership(query, req.user.userId, channelId);
    const result = await query(
      `SELECT u.id, u.username, u.first_name, u.middle_name, u.last_name, u.avatar_color, u.status, cm.role
       FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = $1 AND u.account_type <> 'bot'
         AND NOT (u.is_superadmin AND LOWER(u.username) = 'admin')
       ORDER BY LOWER(u.username)`,
      [channelId]
    );
    res.json({
      members: result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        firstName: row.first_name || '',
        middleName: row.middle_name || '',
        lastName: row.last_name || '',
        avatarColor: row.avatar_color,
        status: row.status,
        role: row.role,
      })),
    });
  } catch (err) {
    console.error('Get channel members error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

// Mark a channel as read for the current user (clears the unread badge)
router.post('/:channelId/read', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    await ensureChannelMembership(query, req.user.userId, channelId);

    await query(
      `INSERT INTO channel_read_at (channel_id, user_id, read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET read_at = NOW()`,
      [channelId, req.user.userId]
    );

    const latestMessageResult = await query(
      `SELECT id FROM messages
       WHERE channel_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [channelId]
    );

    if (latestMessageResult.rows.length > 0) {
      await query(
        `INSERT INTO message_read_receipts (message_id, user_id, read_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (message_id, user_id)
         DO UPDATE SET read_at = NOW()`,
        [latestMessageResult.rows[0].id, req.user.userId]
      );
    }

    res.json({ success: true, readAt: new Date().toISOString() });
  } catch (err) {
    console.error('Mark channel read error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

router.get('/:channelId/read-receipts', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    await ensureChannelMembership(query, req.user.userId, channelId);

    const latestMessageResult = await query(
      `SELECT id FROM messages
       WHERE channel_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [channelId]
    );

    if (latestMessageResult.rows.length === 0) {
      return res.json({ users: [] });
    }

    const latestMessageId = latestMessageResult.rows[0].id;
    const result = await query(
      `SELECT u.id, u.username, u.avatar_color, mrr.read_at
       FROM message_read_receipts mrr
       JOIN users u ON u.id = mrr.user_id
       WHERE mrr.message_id = $1
       ORDER BY mrr.read_at ASC`,
      [latestMessageId]
    );

    res.json({
      users: result.rows.map((u) => ({
        id: u.id,
        username: u.username,
        avatarColor: u.avatar_color,
        readAt: u.read_at,
      })),
    });
  } catch (err) {
    console.error('Get channel read receipts error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

// Join a channel
router.post('/:channelId/join', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    await ensureNotGuest(query, req.user.userId, 'Guests can only be added to channels by a Superadmin');

    // Check channel exists
    const channelResult = await query('SELECT id, is_private FROM channels WHERE id = $1', [channelId]);
    if (channelResult.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    if (channelResult.rows[0].is_private) {
      const membership = await query(
        `SELECT 1 FROM users WHERE id = $1 AND is_superadmin = TRUE`,
        [req.user.userId]
      );
      if (!membership.rows.length) {
        return res.status(403).json({ error: 'Private channels require an invitation from a Superadmin' });
      }
    }

    // Try to join (ignore if already a member)
    await query(
      `INSERT INTO channel_members (channel_id, user_id) 
       VALUES ($1, $2) 
       ON CONFLICT DO NOTHING`,
      [channelId, req.user.userId]
    );

    res.json({ message: 'Joined channel successfully' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Join channel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
