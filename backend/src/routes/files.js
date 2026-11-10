const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const config = require('../config');
const { ensureFileAccess } = require('../security');

// List files shared in channels the user is a member of, and any direct
// messages between the user and others. Newest first.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT f.id, f.original_name, f.size, f.mime_type, f.uploaded_at,
              u.username AS uploader_username,
              c.name AS channel_name,
              m.content AS message_content,
              dm.id AS dm_id,
              dm.sender_id,
              dm.receiver_id
       FROM files f
       JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN messages m ON m.id = f.message_id
       LEFT JOIN channels c ON c.id = m.channel_id
       LEFT JOIN direct_messages dm ON dm.id = f.dm_message_id
       WHERE (
         (f.message_id IS NOT NULL AND m.channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = $1))
         OR (f.dm_message_id IS NOT NULL AND (dm.sender_id = $1 OR dm.receiver_id = $1))
         OR (f.message_id IS NULL AND f.dm_message_id IS NULL AND f.uploaded_by = $1)
       )
       ORDER BY f.uploaded_at DESC
       LIMIT 200`,
      [req.user.userId]
    );

    res.json({
      files: result.rows.map((f) => ({
        id: f.id,
        name: f.original_name,
        size: f.size,
        mimeType: f.mime_type,
        uploadedAt: f.uploaded_at,
        uploaderUsername: f.uploader_username,
        channelName: f.channel_name,
        messageContent: f.message_content,
      })),
    });
  } catch (err) {
    console.error('List files error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Download a specific file (metadata + stream)
router.get('/:id/download', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await ensureFileAccess(query, req.user.userId, id);

    const result = await query(
      `SELECT filename, original_name, mime_type
       FROM files WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const f = result.rows[0];
    const filePath = path.join(config.UPLOAD_DIR, f.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File data is missing on disk' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.original_name)}"`);
    res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Download file error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error during download' });
  }
});

module.exports = router;
