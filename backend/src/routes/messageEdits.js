const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const config = require('../config');
const { ensureChannelMembership, ensureNotTimedOut } = require('../security');
const { findMentionedUsers } = require('../mentions');

// Authors editing and deleting their own channel messages.
// Mounted on /api/messages alongside the main message routes.
const router = express.Router();

const MAX_MESSAGE_LENGTH = 10000;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function loadOwnMessage(messageId, userId) {
  if (!messageId) throw Object.assign(new Error('A valid message ID is required'), { status: 400 });
  const result = await query(
    'SELECT id, channel_id, user_id, content FROM messages WHERE id = $1',
    [messageId]
  );
  if (!result.rows.length) throw Object.assign(new Error('Message not found'), { status: 404 });
  const message = result.rows[0];
  await ensureChannelMembership(query, userId, message.channel_id);
  if (Number(message.user_id) !== Number(userId)) {
    throw Object.assign(new Error('You can only change your own messages'), { status: 403 });
  }
  return message;
}

// Edit your own message. The previous text is kept in message_edits.
router.patch('/:messageId', authenticateToken, async (req, res) => {
  try {
    const messageId = parseId(req.params.messageId);
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'Message content is required' });
    if (content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }

    const message = await loadOwnMessage(messageId, req.user.userId);
    await ensureNotTimedOut(query, req.user.userId, message.channel_id);
    if (content === message.content) {
      return res.json({ message: { id: message.id, channelId: message.channel_id, content, editedAt: null, unchanged: true } });
    }

    await query(
      'INSERT INTO message_edits (message_id, previous_content, edited_by) VALUES ($1, $2, $3)',
      [messageId, message.content, req.user.userId]
    );
    const updated = await query(
      'UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2 RETURNING edited_at',
      [content, messageId]
    );

    // Mentions follow the new text. People newly mentioned are not re-notified.
    const members = await query(
      `SELECT u.id, u.username FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = $1`,
      [message.channel_id]
    );
    const mentioned = findMentionedUsers(content, members.rows)
      .map((user) => Number(user.id))
      .filter((id) => id !== Number(req.user.userId));
    await query(
      'DELETE FROM message_mentions WHERE message_id = $1 AND NOT (user_id = ANY($2::int[]))',
      [messageId, mentioned]
    );
    for (const userId of mentioned) {
      await query(
        'INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [messageId, userId]
      );
    }

    const event = {
      messageId,
      channelId: message.channel_id,
      content,
      editedAt: updated.rows[0].edited_at,
    };
    req.io?.to(`channel_${message.channel_id}`).emit('message_updated', event);
    res.json({ message: { id: messageId, ...event } });
  } catch (err) {
    sendError(res, err, 'Edit message error');
  }
});

// Earlier versions of a message, newest first. Visible to channel members.
router.get('/:messageId/edits', authenticateToken, async (req, res) => {
  try {
    const messageId = parseId(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'A valid message ID is required' });
    const message = await query('SELECT channel_id FROM messages WHERE id = $1', [messageId]);
    if (!message.rows.length) return res.status(404).json({ error: 'Message not found' });
    await ensureChannelMembership(query, req.user.userId, message.rows[0].channel_id);
    const edits = await query(
      `SELECT previous_content, edited_at FROM message_edits
       WHERE message_id = $1 ORDER BY edited_at DESC, id DESC`,
      [messageId]
    );
    res.json({
      edits: edits.rows.map((row) => ({ previousContent: row.previous_content, editedAt: row.edited_at })),
    });
  } catch (err) {
    sendError(res, err, 'Get message edits error');
  }
});

// Delete your own message for everyone, with its attachments and reactions.
router.delete('/:messageId', authenticateToken, async (req, res) => {
  try {
    const messageId = parseId(req.params.messageId);
    const message = await loadOwnMessage(messageId, req.user.userId);
    const channelId = message.channel_id;

    const attachments = await query('SELECT id, filename FROM files WHERE message_id = $1', [messageId]);
    await query('DELETE FROM files WHERE message_id = $1', [messageId]);
    // Replies stay, but no longer point at a message that is gone.
    await query('UPDATE messages SET reply_to = NULL WHERE reply_to = $1', [messageId]);
    await query('DELETE FROM messages WHERE id = $1', [messageId]);

    const uploadDirectory = path.resolve(config.UPLOAD_DIR);
    for (const file of attachments.rows) {
      const shared = await query('SELECT 1 FROM files WHERE filename = $1 LIMIT 1', [file.filename]);
      if (!shared.rows.length) {
        const filePath = path.resolve(uploadDirectory, file.filename);
        if (path.dirname(filePath) === uploadDirectory && path.basename(file.filename) === file.filename) {
          try {
            await fs.promises.unlink(filePath);
          } catch (err) {
            if (err.code !== 'ENOENT') console.error('Could not remove attachment of a deleted message:', err);
          }
        }
      }
      req.io?.to(`channel_${channelId}`).emit('file_deleted', { fileId: file.id, messageId, channelId });
    }

    req.io?.to(`channel_${channelId}`).emit('message_deleted', { messageId, channelId });
    res.json({ deleted: true, messageId });
  } catch (err) {
    sendError(res, err, 'Delete own message error');
  }
});

module.exports = router;
