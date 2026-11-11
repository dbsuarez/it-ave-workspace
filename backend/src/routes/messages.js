const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const config = require('../config');
const { checkUploadedFile, mimeForFilename } = require('../uploadContent');
const { getUploadValidationError, ensureChannelMembership, ensureCanPostToChannel } = require('../security');

const emojiSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isValidReactionEmoji(value) {
  if (typeof value !== 'string' || Array.from(value).length > 10) return false;
  if (Array.from(emojiSegmenter.segment(value)).length !== 1) return false;
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value)
    || /^[#*0-9]\uFE0F?\u20E3$/u.test(value);
}

// File upload setup
const uploadDir = config.UPLOAD_DIR;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const validationError = getUploadValidationError(file, config.MAX_FILE_SIZE_MB);
    if (validationError) {
      return cb(new Error(validationError));
    }
    cb(null, true);
  },
});

// Upload file attachment
router.post('/upload', authenticateToken, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('Upload validation error:', err);
      return res.status(400).json({ error: err.message || 'Invalid file upload' });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const contentError = await checkUploadedFile(req.file.path, req.file.originalname);
      if (contentError) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: contentError });
      }
      const storedMime = mimeForFilename(req.file.originalname);

      const result = await query(
        `INSERT INTO files (message_id, filename, original_name, size, mime_type, uploaded_by) 
         VALUES ($1, $2, $3, $4, $5, $6) 
         RETURNING id`,
        [null, req.file.filename, req.file.originalname, req.file.size, storedMime, req.user.userId]
      );

      res.json({
        fileId: result.rows[0].id,
        filename: req.file.originalname,
        size: req.file.size,
        mimeType: storedMime,
      });
    } catch (uploadErr) {
      console.error('Upload error:', uploadErr);
      const message = uploadErr && uploadErr.message ? uploadErr.message : 'Server error during upload';
      const status = uploadErr && uploadErr.status ? uploadErr.status : 500;
      res.status(status).json({ error: message });
    }
  });
});

router.get('/:channelId/pins', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    await ensureChannelMembership(query, req.user.userId, channelId);
    const result = await query(
      `SELECT m.id, m.channel_id, m.user_id, m.content, m.created_at,
              m.pinned_at, m.pinned_by, u.username, u.avatar_color,
              pinner.username AS pinned_by_username
       FROM messages m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN users pinner ON pinner.id = m.pinned_by
       WHERE m.channel_id = $1 AND m.pinned_at IS NOT NULL
       ORDER BY m.pinned_at DESC, m.id DESC`,
      [channelId]
    );
    const messageIds = result.rows.map((message) => message.id);
    let attachmentsByMessage = {};
    if (messageIds.length > 0) {
      const files = await query(
        `SELECT id, message_id, original_name, size, mime_type, uploaded_by, uploaded_by
         FROM files WHERE message_id = ANY($1)`,
        [messageIds]
      );
      for (const file of files.rows) {
        if (!attachmentsByMessage[file.message_id]) attachmentsByMessage[file.message_id] = [];
        attachmentsByMessage[file.message_id].push({
          id: file.id,
          filename: file.original_name,
          size: file.size,
          mimeType: file.mime_type,
          uploadedBy: file.uploaded_by,
          uploadedBy: file.uploaded_by,
        });
      }
    }

    res.json({
      messages: result.rows.map((message) => ({
        id: message.id,
        channelId: message.channel_id,
        userId: message.user_id,
        username: message.username,
        avatarColor: message.avatar_color,
        content: message.content,
        createdAt: message.created_at,
        pinned: true,
        pinnedAt: message.pinned_at,
        pinnedBy: message.pinned_by,
        pinnedByUsername: message.pinned_by_username,
        attachments: attachmentsByMessage[message.id] || [],
      })),
    });
  } catch (err) {
    console.error('Get pinned messages error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

// Get messages for a channel (paginated)
router.get('/:channelId', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    await ensureChannelMembership(query, req.user.userId, channelId);

    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);

    const channelCheck = await query('SELECT id FROM channels WHERE id = $1', [channelId]);
    if (channelCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const result = await query(`
      SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to, m.edited_at, m.created_at,
             m.pinned_at, m.pinned_by,
             u.username, u.avatar_color,
             parent.id AS reply_to_message_id, parent.content AS reply_to_content,
             parent_user.username AS reply_to_username
      FROM messages m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN messages parent ON parent.id = m.reply_to
      LEFT JOIN users parent_user ON parent_user.id = parent.user_id
      WHERE m.channel_id = $1
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2 OFFSET $3
    `, [channelId, limit, offset]);

    // Get reactions for these messages
    const messageIds = result.rows.map((m) => m.id);
    let reactions = [];
    if (messageIds.length > 0) {
      const reactionResult = await query(
        `SELECT message_id, emoji, COUNT(*)::int AS count, ARRAY_AGG(user_id) AS users
         FROM reactions
         WHERE message_id = ANY($1)
         GROUP BY message_id, emoji`,
        [messageIds]
      );
      reactions = reactionResult.rows;
    }

    // Map reactions by message ID
    const reactionsByMessage = {};
    reactions.forEach((r) => {
      if (!reactionsByMessage[r.message_id]) {
        reactionsByMessage[r.message_id] = [];
      }
      reactionsByMessage[r.message_id].push({
        emoji: r.emoji,
        count: r.count,
        users: r.users || [],
      });
    });

    // Get file attachments for these messages
    let attachmentsByMessage = {};
    if (messageIds.length > 0) {
      const fileResult = await query(
        `SELECT id, message_id, filename, original_name, size, mime_type, uploaded_by
         FROM files WHERE message_id = ANY($1)`,
        [messageIds]
      );
      fileResult.rows.forEach((f) => {
        if (!attachmentsByMessage[f.message_id]) {
          attachmentsByMessage[f.message_id] = [];
        }
        attachmentsByMessage[f.message_id].push({
          id: f.id,
          filename: f.original_name,
          size: f.size,
          mimeType: f.mime_type,
          uploadedBy: f.uploaded_by,
        });
      });
    }

    const messages = result.rows.map((m) => ({
      id: m.id,
      channelId: m.channel_id,
      userId: m.user_id,
      username: m.username,
      avatarColor: m.avatar_color,
      content: m.content,
      replyTo: m.reply_to,
      replyToMessage: m.reply_to ? {
        id: m.reply_to_message_id,
        username: m.reply_to_username,
        content: m.reply_to_content,
      } : null,
      editedAt: m.edited_at,
      createdAt: m.created_at,
      pinned: m.pinned_at !== null,
      pinnedAt: m.pinned_at,
      pinnedBy: m.pinned_by,
      reactions: reactionsByMessage[m.id] || [],
      attachments: attachmentsByMessage[m.id] || [],
    }));

    res.json({
      messages: messages.reverse(), // Return oldest first
      hasMore: result.rows.length === limit,
    });
  } catch (err) {
    console.error('Get messages error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

router.get('/:channelId/context/:messageId', authenticateToken, async (req, res) => {
  try {
    const { channelId, messageId } = req.params;
    await ensureChannelMembership(query, req.user.userId, channelId);

    const target = await query(
      'SELECT id, created_at FROM messages WHERE id = $1 AND channel_id = $2',
      [messageId, channelId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found in this channel' });
    }

    const position = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE (created_at, id) < ($2, $3))::int AS older_count
       FROM messages
       WHERE channel_id = $1`,
      [channelId, target.rows[0].created_at, target.rows[0].id]
    );
    const { total, older_count: olderCount } = position.rows[0];
    const indexFromNewest = total - olderCount - 1;

    res.json({ offset: Math.floor(indexFromNewest / 100) * 100 });
  } catch (err) {
    console.error('Get message context error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

// Compatibility routes: GET/POST /api/messages/:messageId/replies
// The desktop client uses this simpler API surface.
router.get('/:messageId/replies', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const parentResult = await query(
      'SELECT channel_id FROM messages WHERE id = $1',
      [messageId]
    );
    if (parentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Parent message not found' });
    }
    await ensureChannelMembership(query, req.user.userId, parentResult.rows[0].channel_id);

    const result = await query(
      `SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to, m.edited_at, m.created_at,
              u.username, u.avatar_color
       FROM messages m
       JOIN users u ON m.user_id = u.id
       WHERE m.reply_to = $1
       ORDER BY m.created_at ASC`,
      [messageId]
    );
    res.json({
      replies: result.rows.map((m) => ({
        id: m.id,
        channelId: m.channel_id,
        userId: m.user_id,
        username: m.username,
        avatarColor: m.avatar_color,
        content: m.content,
        replyTo: m.reply_to,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error('Get replies error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

router.post('/:messageId/replies', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }
    const parent = await query(
      'SELECT channel_id FROM messages WHERE id = $1',
      [messageId]
    );
    if (parent.rows.length === 0) {
      return res.status(404).json({ error: 'Parent message not found' });
    }
    await ensureChannelMembership(query, req.user.userId, parent.rows[0].channel_id);
    await ensureCanPostToChannel(query, req.user.userId, parent.rows[0].channel_id);

    const result = await query(
      `INSERT INTO messages (channel_id, user_id, content, reply_to)
       VALUES ($1, $2, $3, $4)
       RETURNING id, channel_id, user_id, content, reply_to, created_at`,
      [parent.rows[0].channel_id, req.user.userId, content, messageId]
    );
    const msg = result.rows[0];
    const u = await query(
      'SELECT username, avatar_color FROM users WHERE id = $1',
      [req.user.userId]
    );
    res.status(201).json({
      reply: {
        id: msg.id,
        channelId: msg.channel_id,
        userId: msg.user_id,
        username: u.rows[0].username,
        avatarColor: u.rows[0].avatar_color,
        content: msg.content,
        replyTo: msg.reply_to,
        createdAt: msg.created_at,
      },
    });
  } catch (err) {
    console.error('Post reply error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

// Get thread replies for a message
router.get('/:channelId/threads/:messageId', authenticateToken, async (req, res) => {
  try {
    const { channelId, messageId } = req.params;
    await ensureChannelMembership(query, req.user.userId, channelId);

    const result = await query(`
      SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to, m.edited_at, m.created_at,
             u.username, u.avatar_color
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.reply_to = $1
      ORDER BY m.created_at ASC
    `, [messageId]);

    res.json({
      replies: result.rows.map((m) => ({
        id: m.id,
        channelId: m.channel_id,
        userId: m.user_id,
        username: m.username,
        avatarColor: m.avatar_color,
        content: m.content,
        replyTo: m.reply_to,
        editedAt: m.edited_at,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error('Get thread replies error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

router.patch('/:messageId/pin', authenticateToken, async (req, res) => {
  try {
    const messageId = Number(req.params.messageId);
    const { pinned } = req.body || {};
    if (!Number.isSafeInteger(messageId) || messageId < 1) {
      return res.status(400).json({ error: 'A valid message ID is required' });
    }
    if (typeof pinned !== 'boolean') {
      return res.status(400).json({ error: 'Pinned must be true or false' });
    }

    const message = await query(
      'SELECT id, channel_id FROM messages WHERE id = $1',
      [messageId]
    );
    if (message.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const { channel_id: channelId } = message.rows[0];
    await ensureChannelMembership(query, req.user.userId, channelId);

    const result = await query(
      `UPDATE messages
       SET pinned_at = CASE WHEN $1 THEN COALESCE(pinned_at, NOW()) ELSE NULL END,
           pinned_by = CASE WHEN $1 THEN COALESCE(pinned_by, $2) ELSE NULL END
       WHERE id = $3
       RETURNING id, channel_id, pinned_at, pinned_by`,
      [pinned, req.user.userId, messageId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const updated = result.rows[0];
    const event = {
      messageId: updated.id,
      channelId: updated.channel_id,
      pinned: updated.pinned_at !== null,
      pinnedAt: updated.pinned_at,
      pinnedBy: updated.pinned_by,
    };
    req.io?.to(`channel_${channelId}`).emit('message_pin_updated', event);
    res.json({ message: event });
  } catch (err) {
    console.error('Update message pin error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

// Reactors for a single message (popup lists names and emojis)
router.get('/:messageId/reactions', authenticateToken, async (req, res) => {
  try {
    const messageId = Number(req.params.messageId);
    if (!Number.isFinite(messageId)) {
      return res.status(400).json({ error: 'Invalid message id' });
    }
    const messageCheck = await query('SELECT channel_id FROM messages WHERE id = $1', [messageId]);
    if (messageCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const channelId = messageCheck.rows[0].channel_id;
    await ensureChannelMembership(query, req.user.userId, channelId);

    const rows = await query(
      `SELECT r.emoji, u.id AS user_id, u.username, u.avatar_color AS avatar_color
       FROM reactions r JOIN users u ON u.id = r.user_id
       WHERE r.message_id = $1
       ORDER BY r.emoji ASC, u.username ASC`,
      [messageId]
    );
    res.json({ messageId, channelId, reactions: rows.rows });
  } catch (err) {
    console.error('Reactions detail error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
});


// Add reaction to a message
router.post('/:messageId/reactions', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const emoji = req.body && req.body.emoji;

    if (!isValidReactionEmoji(emoji)) {
      return res.status(400).json({ error: 'Choose a single supported emoji reaction' });
    }

    const messageCheck = await query(
      'SELECT channel_id, user_id, content FROM messages WHERE id = $1',
      [messageId]
    );
    if (messageCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const channelId = messageCheck.rows[0].channel_id;
    const messageAuthorId = messageCheck.rows[0].user_id;
    await ensureChannelMembership(query, req.user.userId, channelId);

    // Tell everyone in the channel about the new reaction state for this message.
    const broadcastReactions = async () => {
      const current = await query(
        `SELECT emoji, COUNT(*)::int AS count, ARRAY_AGG(user_id) AS users
         FROM reactions
         WHERE message_id = $1
         GROUP BY emoji
         ORDER BY MIN(id)`,
        [messageId]
      );
      const reactions = current.rows.map((row) => ({
        emoji: row.emoji,
        count: row.count,
        users: row.users || [],
      }));
      req.io?.to(`channel_${channelId}`).emit('message_reactions_updated', {
        messageId: Number(messageId),
        channelId: Number(channelId),
        reactions,
      });
      return reactions;
    };

    // One reaction per person per message. If the user taps the same emoji they
    // already used, that removes it. Tapping a different emoji replaces their
    // previous reaction on this message.
    const existing = await query(
      'SELECT id, emoji FROM reactions WHERE message_id = $1 AND user_id = $2',
      [messageId, req.user.userId]
    );

    if (existing.rows.length > 0 && existing.rows[0].emoji === emoji) {
      await query(
        'DELETE FROM reactions WHERE id = $1',
        [existing.rows[0].id]
      );
      res.json({ message: 'Reaction removed', reactions: await broadcastReactions() });
    } else {
      await query(
        'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2',
        [messageId, req.user.userId]
      );
      await query(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [messageId, req.user.userId, emoji]
      );
      const reactions = await broadcastReactions();
      if (messageAuthorId && Number(messageAuthorId) !== Number(req.user.userId)) {
        try {
          const context = await query(
            `SELECT c.name AS channel_name, u.username, u.avatar_color
             FROM channels c CROSS JOIN users u
             WHERE c.id = $1 AND u.id = $2`,
            [channelId, req.user.userId]
          );
          req.io?.to(`user_${messageAuthorId}`).emit('activity', {
            type: 'reaction',
            messageId: Number(messageId),
            channelId: Number(channelId),
            channelName: context.rows[0]?.channel_name || '',
            actorId: req.user.userId,
            actorUsername: context.rows[0]?.username || '',
            actorAvatarColor: context.rows[0]?.avatar_color || null,
            preview: String(messageCheck.rows[0].content || '').slice(0, 200),
            emoji,
            createdAt: new Date().toISOString(),
          });
        } catch (activityErr) {
          console.error('Reaction activity notification error:', activityErr);
        }
      }
      res.status(201).json({ message: 'Reaction added', reactions });
    }
  } catch (err) {
    console.error('Add reaction error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

module.exports = router;
