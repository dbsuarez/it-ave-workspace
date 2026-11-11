const express = require('express');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

router.get('/', authenticateToken, async (req, res) => {
  const searchTerm = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (searchTerm.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }
  if (searchTerm.length > 100) {
    return res.status(400).json({ error: 'Search query must be 100 characters or fewer' });
  }

  const pattern = `%${escapeLike(searchTerm)}%`;
  const userId = req.user.userId;

  try {
    const [messages, directMessages, people, files] = await Promise.all([
      query(
        `SELECT m.id, m.channel_id, c.name AS channel_name, m.content, m.created_at,
                u.username
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         JOIN users u ON u.id = m.user_id
         WHERE m.channel_id IN (
           SELECT channel_id FROM channel_members WHERE user_id = $1
         )
           AND m.content ILIKE $2 ESCAPE '\\'
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 5`,
        [userId, pattern]
      ),
      query(
        `SELECT dm.id, dm.content, dm.created_at,
                CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END AS other_user_id,
                other_user.username AS other_username
         FROM direct_messages dm
         JOIN users other_user
           ON other_user.id = CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END
         WHERE (dm.sender_id = $1 OR dm.receiver_id = $1)
           AND dm.content ILIKE $2 ESCAPE '\\'
         ORDER BY dm.created_at DESC, dm.id DESC
         LIMIT 5`,
        [userId, pattern]
      ),
      query(
        `SELECT id, username
         FROM users
         WHERE id != $1 AND username ILIKE $2 ESCAPE '\\'
         ORDER BY username
         LIMIT 5`,
        [userId, pattern]
      ),
      query(
        `SELECT f.id, f.original_name, f.uploaded_at, u.username AS uploader_username,
                c.id AS channel_id, c.name AS channel_name,
                dm.sender_id, dm.receiver_id,
                CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END AS other_user_id,
                other_user.username AS other_username
         FROM files f
         JOIN users u ON u.id = f.uploaded_by
         LEFT JOIN messages m ON m.id = f.message_id
         LEFT JOIN channels c ON c.id = m.channel_id
         LEFT JOIN direct_messages dm ON dm.id = f.dm_message_id
         LEFT JOIN users other_user
           ON other_user.id = CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END
         WHERE f.original_name ILIKE $2 ESCAPE '\\'
           AND (
             (f.message_id IS NOT NULL AND m.channel_id IN (
               SELECT channel_id FROM channel_members WHERE user_id = $1
             ))
             OR (f.dm_message_id IS NOT NULL AND (dm.sender_id = $1 OR dm.receiver_id = $1))
             OR (f.message_id IS NULL AND f.dm_message_id IS NULL AND f.uploaded_by = $1)
           )
         ORDER BY f.uploaded_at DESC, f.id DESC
         LIMIT 5`,
        [userId, pattern]
      ),
    ]);

    res.json({
      messages: messages.rows.map((message) => ({
        id: message.id,
        channelId: message.channel_id,
        channelName: message.channel_name,
        username: message.username,
        content: message.content,
        createdAt: message.created_at,
      })),
      directMessages: directMessages.rows.map((message) => ({
        id: message.id,
        userId: message.other_user_id,
        username: message.other_username,
        content: message.content,
        createdAt: message.created_at,
      })),
      people: people.rows.map((person) => ({
        id: person.id,
        username: person.username,
      })),
      files: files.rows.map((file) => ({
        id: file.id,
        name: file.original_name,
        uploadedAt: file.uploaded_at,
        uploaderUsername: file.uploader_username,
        channelId: file.channel_id,
        channelName: file.channel_name,
        userId: file.other_user_id,
        username: file.other_username,
      })),
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
