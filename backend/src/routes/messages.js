const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const config = require('../config');
const { getUploadValidationError, ensureChannelMembership } = require('../security');

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

      const result = await query(
        `INSERT INTO files (message_id, filename, original_name, size, mime_type, uploaded_by) 
         VALUES ($1, $2, $3, $4, $5, $6) 
         RETURNING id`,
        [null, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, req.user.userId]
      );

      res.json({
        fileId: result.rows[0].id,
        filename: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      });
    } catch (uploadErr) {
      console.error('Upload error:', uploadErr);
      const message = uploadErr && uploadErr.message ? uploadErr.message : 'Server error during upload';
      const status = uploadErr && uploadErr.status ? uploadErr.status : 500;
      res.status(status).json({ error: message });
    }
  });
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
             u.username, u.avatar_color
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3
    `, [channelId, limit, offset]);

    // Get reactions for these messages
    const messageIds = result.rows.map((m) => m.id);
    let reactions = [];
    if (messageIds.length > 0) {
      const reactionResult = await query(
        `SELECT message_id, emoji, COUNT(*)::int AS count
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
      editedAt: m.edited_at,
      createdAt: m.created_at,
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

// Add reaction to a message
router.post('/:messageId/reactions', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required' });
    }

    const messageCheck = await query(
      'SELECT channel_id FROM messages WHERE id = $1',
      [messageId]
    );
    if (messageCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    await ensureChannelMembership(query, req.user.userId, messageCheck.rows[0].channel_id);

    const existing = await query(
      'SELECT id FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, req.user.userId, emoji]
    );

    if (existing.rows.length > 0) {
      await query(
        'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, req.user.userId, emoji]
      );
      res.json({ message: 'Reaction removed' });
    } else {
      await query(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [messageId, req.user.userId, emoji]
      );
      res.status(201).json({ message: 'Reaction added' });
    }
  } catch (err) {
    console.error('Add reaction error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
});

module.exports = router;
