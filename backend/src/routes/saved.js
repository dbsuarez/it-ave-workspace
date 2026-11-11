const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership } = require('../security');

// Personal "saved for later" items: channel messages and files. Private to
// each user and separate from shared channel pins.
const router = express.Router();
router.use(authenticateToken);

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

// Only items in channels the user can still see are returned.
const ACCESS = `EXISTS (
  SELECT 1 FROM users me WHERE me.id = $1 AND (me.is_superadmin = TRUE OR EXISTS (
    SELECT 1 FROM channel_members cm WHERE cm.channel_id = m.channel_id AND cm.user_id = $1
  ))
)`;

router.get('/', async (req, res) => {
  try {
    const messages = await query(
      `SELECT s.id, s.created_at AS saved_at, m.id AS message_id, m.channel_id, m.content,
              m.created_at, c.name AS channel_name, u.username, u.avatar_color
       FROM saved_items s
       JOIN messages m ON m.id = s.message_id
       JOIN channels c ON c.id = m.channel_id
       JOIN users u ON u.id = m.user_id
       WHERE s.user_id = $1 AND ${ACCESS}`,
      [req.user.userId]
    );
    const files = await query(
      `SELECT s.id, s.created_at AS saved_at, f.id AS file_id, f.original_name, f.size, f.mime_type,
              m.id AS message_id, m.channel_id, c.name AS channel_name, u.username
       FROM saved_items s
       JOIN files f ON f.id = s.file_id
       JOIN messages m ON m.id = f.message_id
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE s.user_id = $1 AND ${ACCESS}`,
      [req.user.userId]
    );
    const items = [
      ...messages.rows.map((row) => ({
        id: row.id,
        type: 'message',
        savedAt: row.saved_at,
        messageId: row.message_id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        username: row.username,
        avatarColor: row.avatar_color,
        content: row.content,
        createdAt: row.created_at,
      })),
      ...files.rows.map((row) => ({
        id: row.id,
        type: 'file',
        savedAt: row.saved_at,
        fileId: row.file_id,
        name: row.original_name,
        size: row.size,
        mimeType: row.mime_type,
        messageId: row.message_id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        username: row.username || 'former user',
      })),
    ].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    res.json({ items });
  } catch (err) {
    sendError(res, err, 'List saved items error');
  }
});

// Save a channel message ({ messageId }) or a channel file ({ fileId }).
router.post('/', async (req, res) => {
  try {
    const messageId = req.body?.messageId === undefined ? null : parseId(req.body.messageId);
    const fileId = req.body?.fileId === undefined ? null : parseId(req.body.fileId);
    if ((messageId === null) === (fileId === null)) {
      return res.status(400).json({ error: 'Provide exactly one of messageId or fileId' });
    }

    let channelId;
    if (messageId) {
      const message = await query('SELECT channel_id FROM messages WHERE id = $1', [messageId]);
      if (!message.rows.length) return res.status(404).json({ error: 'Message not found' });
      channelId = message.rows[0].channel_id;
    } else {
      const file = await query(
        `SELECT m.channel_id FROM files f JOIN messages m ON m.id = f.message_id WHERE f.id = $1`,
        [fileId]
      );
      if (!file.rows.length) {
        return res.status(404).json({ error: 'File not found, or it is not attached to a channel message' });
      }
      channelId = file.rows[0].channel_id;
    }
    await ensureChannelMembership(query, req.user.userId, channelId);

    const existing = await query(
      `SELECT id FROM saved_items
       WHERE user_id = $1 AND message_id IS NOT DISTINCT FROM $2 AND file_id IS NOT DISTINCT FROM $3`,
      [req.user.userId, messageId, fileId]
    );
    if (existing.rows.length) return res.json({ id: existing.rows[0].id, alreadySaved: true });

    const saved = await query(
      'INSERT INTO saved_items (user_id, message_id, file_id) VALUES ($1, $2, $3) RETURNING id',
      [req.user.userId, messageId, fileId]
    );
    res.status(201).json({ id: saved.rows[0].id });
  } catch (err) {
    sendError(res, err, 'Save item error');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid saved item ID is required' });
    const removed = await query(
      'DELETE FROM saved_items WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.userId]
    );
    if (!removed.rows.length) return res.status(404).json({ error: 'Saved item not found' });
    res.json({ removed: true });
  } catch (err) {
    sendError(res, err, 'Remove saved item error');
  }
});

module.exports = router;
