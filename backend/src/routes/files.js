const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query, pool } = require('../db');
const authenticateToken = require('../middleware/auth');
const config = require('../config');
const { ensureFileAccess } = require('../security');

// List files shared in channels the user is a member of, and any direct
// messages between the user and others. Newest first.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT f.id, f.original_name, f.size, f.mime_type, f.uploaded_at, f.uploaded_by,
              u.username AS uploader_username,
              c.name AS channel_name,
              m.channel_id,
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
        uploadedBy: f.uploaded_by,
        name: f.original_name,
        size: f.size,
        mimeType: f.mime_type,
        uploadedAt: f.uploaded_at,
        uploaderUsername: f.uploader_username,
        channelName: f.channel_name,
        channelId: f.channel_id,
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

router.delete('/:id', authenticateToken, async (req, res) => {
  const fileId = Number(req.params.id);
  if (!Number.isSafeInteger(fileId) || fileId < 1) {
    return res.status(400).json({ error: 'A valid file ID is required' });
  }

  let client;
  let transactionStarted = false;
  let originalPath = null;
  let stagedPath = null;
  let deletedFile = null;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const result = await client.query(
      `SELECT f.id, f.filename, f.uploaded_by, f.message_id, f.dm_message_id,
              m.channel_id, dm.sender_id, dm.receiver_id
       FROM files f
       LEFT JOIN messages m ON m.id = f.message_id
       LEFT JOIN direct_messages dm ON dm.id = f.dm_message_id
       WHERE f.id = $1
       FOR UPDATE OF f`,
      [fileId]
    );
    if (result.rows.length === 0) {
      const error = new Error('File not found');
      error.status = 404;
      throw error;
    }

    const file = result.rows[0];
    const isUploader = Number(file.uploaded_by) === Number(req.user.userId);
    let moderationReason = null;
    if (!isUploader) {
      if (!file.channel_id) {
        const error = new Error('Only the uploader can delete this file');
        error.status = 403;
        throw error;
      }

      const moderator = await client.query(
        `SELECT 1
         FROM users u
         WHERE u.id = $2 AND (
           u.is_superadmin = TRUE OR EXISTS (
             SELECT 1 FROM channel_members cm
             WHERE cm.channel_id = $1 AND cm.user_id = u.id AND cm.role = 'moderator'
           )
         )`,
        [file.channel_id, req.user.userId]
      );
      if (moderator.rows.length === 0) {
        const error = new Error('Only the uploader or a channel moderator can delete this file');
        error.status = 403;
        throw error;
      }

      moderationReason = String(req.body?.reason || '').trim();
      if (!moderationReason || moderationReason.length > 500) {
        const error = new Error('A deletion reason between 1 and 500 characters is required');
        error.status = 400;
        throw error;
      }
    }

    const sharedFilename = await client.query(
      'SELECT id FROM files WHERE filename = $1 AND id <> $2 LIMIT 1',
      [file.filename, fileId]
    );
    if (sharedFilename.rows.length === 0) {
      const uploadDirectory = path.resolve(config.UPLOAD_DIR);
      originalPath = path.resolve(uploadDirectory, file.filename);
      if (path.dirname(originalPath) !== uploadDirectory || path.basename(file.filename) !== file.filename) {
        throw new Error('Stored file path is invalid');
      }

      stagedPath = path.join(uploadDirectory, `.deleting-${fileId}-${crypto.randomUUID()}`);
      try {
        await fs.promises.rename(originalPath, stagedPath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          stagedPath = null;
        } else {
          throw err;
        }
      }
    }

    const deletion = await client.query(
      'DELETE FROM files WHERE id = $1 RETURNING id',
      [fileId]
    );
    if (deletion.rows.length === 0) {
      const error = new Error('File not found');
      error.status = 404;
      throw error;
    }
    deletedFile = file;

    if (moderationReason) {
      await client.query(
        `INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details)
         VALUES ($1, $2, $3, 'attachment_deleted', $4)`,
        [
          file.channel_id,
          req.user.userId,
          file.uploaded_by,
          JSON.stringify({
            fileId: file.id,
            reason: moderationReason,
            messageId: file.message_id,
          }),
        ]
      );
    }

    await client.query('COMMIT');
    transactionStarted = false;

    if (stagedPath) {
      try {
        await fs.promises.unlink(stagedPath);
      } catch (err) {
        console.error('Deleted file record but failed to remove stored file:', err);
        emitFileDeleted(req.io, deletedFile);
        return res.status(500).json({
          error: 'The attachment was removed from messages, but its stored file could not be deleted. Contact the workspace administrator.',
        });
      }
    }

    emitFileDeleted(req.io, deletedFile);
    res.json({ deleted: true, fileId });
  } catch (err) {
    if (transactionStarted && client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback file deletion error:', rollbackErr);
      }
    }
    if (stagedPath && originalPath) {
      try {
        await fs.promises.rename(stagedPath, originalPath);
      } catch (restoreErr) {
        console.error('Restore file after failed deletion error:', restoreErr);
      }
    }
    console.error('Delete file error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Server error during file deletion' });
  } finally {
    client?.release();
  }
});

function emitFileDeleted(io, file) {
  if (!io || !file) return;
  const event = {
    fileId: file.id,
    messageId: file.message_id,
    dmMessageId: file.dm_message_id,
    channelId: file.channel_id,
  };
  if (file.channel_id) {
    io.to(`channel_${file.channel_id}`).emit('file_deleted', event);
  }
  if (file.sender_id) {
    io.to(`user_${file.sender_id}`).emit('file_deleted', event);
  }
  if (file.receiver_id && Number(file.receiver_id) !== Number(file.sender_id)) {
    io.to(`user_${file.receiver_id}`).emit('file_deleted', event);
  }
}

module.exports = router;
