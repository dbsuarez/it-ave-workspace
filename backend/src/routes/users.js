const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const config = require('../config');
const { ensureDirectMessageAccess } = require('../security');
const { checkUploadedFile, mimeForFilename } = require('../uploadContent');
const { fullName } = require('../personName');

// ---- profile photos -----------------------------------------------------------------------------
// One small picture per person (PNG or JPEG, 2 MB at most; the app crops and shrinks it first). It is
// stored in the uploads folder under a name made only from the user's id, and served to signed-in people
// who may see that user (everyone, except that guests only see people they share a channel with).
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
      cb(null, config.UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const ext = (/\.([A-Za-z0-9]+)$/.exec(file.originalname || '') || [])[1].toLowerCase();
      cb(null, `avatar-${req.user.userId}-${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: MAX_PHOTO_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = (/\.([A-Za-z0-9]+)$/.exec(file.originalname || '') || [])[1];
    if (!ext || !PHOTO_EXTENSIONS.has(ext.toLowerCase())) return cb(new Error('A profile photo must be a PNG or JPEG picture'));
    cb(null, true);
  },
});

const photoVersion = (row) => (row.photo_file && row.photo_updated_at ? new Date(row.photo_updated_at).getTime() : null);
const removeStoredPhoto = (name) => (name ? fs.promises.unlink(path.join(config.UPLOAD_DIR, name)).catch(() => {}) : Promise.resolve());

router.put('/me/photo', authenticateToken, (req, res) => {
  photoUpload.single('file')(req, res, async (err) => {
    const discard = () => (req.file ? fs.promises.unlink(req.file.path).catch(() => {}) : Promise.resolve());
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? 'A profile photo can be at most 2MB' : (err.message || 'Invalid upload') });
    }
    try {
      if (!req.file) return res.status(400).json({ error: 'No picture uploaded' });
      const problem = await checkUploadedFile(req.file.path, req.file.originalname);
      if (problem) { await discard(); return res.status(400).json({ error: problem }); }
      const previous = (await query('SELECT photo_file FROM users WHERE id = $1', [req.user.userId])).rows[0];
      const saved = await query(
        'UPDATE users SET photo_file = $1, photo_updated_at = NOW() WHERE id = $2 RETURNING photo_file, photo_updated_at',
        [req.file.filename, req.user.userId]
      );
      if (previous && previous.photo_file && previous.photo_file !== req.file.filename) await removeStoredPhoto(previous.photo_file);
      req.io?.emit('user_photo_updated', { userId: Number(req.user.userId), photoVersion: photoVersion(saved.rows[0]) });
      res.json({ photoVersion: photoVersion(saved.rows[0]) });
    } catch (uploadErr) {
      await discard();
      console.error('Profile photo upload error:', uploadErr);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

router.delete('/me/photo', authenticateToken, async (req, res) => {
  try {
    const previous = (await query('SELECT photo_file FROM users WHERE id = $1', [req.user.userId])).rows[0];
    await query('UPDATE users SET photo_file = NULL, photo_updated_at = NULL WHERE id = $1', [req.user.userId]);
    if (previous) await removeStoredPhoto(previous.photo_file);
    req.io?.emit('user_photo_updated', { userId: Number(req.user.userId), photoVersion: null });
    res.json({ photoVersion: null });
  } catch (err) {
    console.error('Remove profile photo error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:userId/photo', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'A valid user ID is required' });
    const found = await query(
      `SELECT u.photo_file, u.photo_updated_at FROM users u
       WHERE u.id = $2 AND u.photo_file IS NOT NULL AND (
         u.id = $1
         OR NOT EXISTS (SELECT 1 FROM users me WHERE me.id = $1 AND me.account_type = 'guest')
         OR EXISTS (SELECT 1 FROM channel_members a JOIN channel_members b ON a.channel_id = b.channel_id
                    WHERE a.user_id = $1 AND b.user_id = u.id))`,
      [req.user.userId, userId]
    );
    const row = found.rows[0];
    if (!row) return res.status(404).json({ error: 'No photo' });
    const file = path.join(config.UPLOAD_DIR, row.photo_file);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'No photo' });
    const etag = `"${photoVersion(row)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', mimeForFilename(row.photo_file));
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error('Get profile photo error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all users (for DM list, etc.)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, username, first_name, middle_name, last_name, email, avatar_color, status, last_seen, created_at,
              status_text, status_emoji, dnd_until, account_type, job_title, photo_file, photo_updated_at,
              (SELECT r.color FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = users.id ORDER BY r.position, r.id LIMIT 1) AS role_color
       FROM users
       WHERE id != $1
         AND account_type <> 'bot'
         AND NOT (is_superadmin AND LOWER(username) = 'admin')
         AND deactivated_at IS NULL
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
        firstName: u.first_name || '',
        middleName: u.middle_name || '',
        lastName: u.last_name || '',
        email: u.email,
        avatarColor: u.avatar_color,
        status: u.status,
        lastSeen: u.last_seen,
        createdAt: u.created_at,
        statusText: u.status_text || '',
        statusEmoji: u.status_emoji || '',
        accountType: u.account_type || 'member',
        roleColor: u.role_color || null,
        jobTitle: u.job_title || '',
        photoVersion: photoVersion(u),
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
// The people you have a direct-message conversation with, the most recent conversation first (the DM list in the sidebar).
router.get('/dm-partners', authenticateToken, async (req, res) => {
  try {
    const me = req.user.userId;
    const rows = (await query(
      `SELECT other_id, MAX(created_at) AS last_at FROM (
         SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_id, created_at
         FROM direct_messages WHERE sender_id = $1 OR receiver_id = $1
       ) t WHERE other_id IS NOT NULL AND other_id <> $1 GROUP BY other_id ORDER BY last_at DESC LIMIT 300`,
      [me]
    )).rows;
    res.json({ partners: rows.map((row) => ({ userId: row.other_id, lastAt: new Date(row.last_at).toISOString() })) });
  } catch (err) {
    console.error('Get DM partners error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// The small profile card shown next to a person's name or picture. Only what a coworker needs at a glance: no email, no phone, no role names.
// Not for the built-in admin account or people who are deactivated; a guest only gets people they share a channel with.
router.get('/:userId/card', authenticateToken, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.userId)) return res.status(400).json({ error: 'A valid person is required' });
    const id = Number(req.params.userId);
    const viewer = req.user.userId;
    const row = (await query(
      `SELECT u.id, u.username, u.first_name, u.middle_name, u.last_name, u.avatar_color, u.status, u.status_text, u.status_emoji, u.job_title,
              u.department, u.location, u.profile, u.photo_file, u.photo_updated_at, u.last_seen, u.created_at, u.account_type,
              m.username AS manager_username, m.first_name AS manager_first, m.middle_name AS manager_middle, m.last_name AS manager_last,
              CASE WHEN u.id = $2 THEN NULL ELSE (SELECT COUNT(*)::int FROM channel_members a JOIN channel_members b ON b.channel_id = a.channel_id
                                                   WHERE a.user_id = $2 AND b.user_id = u.id) END AS shared_channels,
              (EXISTS (SELECT 1 FROM users me WHERE me.id = $2 AND me.account_type = 'guest')
               AND u.id <> $2
               AND NOT EXISTS (SELECT 1 FROM channel_members a JOIN channel_members b ON b.channel_id = a.channel_id WHERE a.user_id = $2 AND b.user_id = u.id)) AS hidden_from_guest
       FROM users u LEFT JOIN users m ON m.id = u.manager_id
       WHERE u.id = $1 AND u.account_type <> 'bot' AND u.deactivated_at IS NULL AND (u.id = $2 OR NOT (u.is_superadmin AND LOWER(u.username) = 'admin'))`,
      [id, viewer]
    )).rows[0];
    if (!row || row.hidden_from_guest) return res.status(404).json({ error: 'Person not found' });
    const profile = row.profile && typeof row.profile === 'object' ? row.profile : {};
    const own = Number(row.id) === Number(viewer);
    res.json({
      card: {
        id: row.id,
        username: row.username,
        firstName: row.first_name || '',
        middleName: row.middle_name || '',
        lastName: row.last_name || '',
        avatarColor: row.avatar_color,
        photoVersion: photoVersion(row),
        status: row.status,
        statusText: row.status_text || '',
        statusEmoji: row.status_emoji || '',
        jobTitle: row.job_title || '',
        department: row.department || '',
        location: own || !(profile.hide && profile.hide.location) ? row.location || '' : '',
        managerName: fullName({ first_name: row.manager_first, middle_name: row.manager_middle, last_name: row.manager_last }) || '',
        accountType: row.account_type || 'member',
        lastSeen: row.last_seen,
        memberSince: row.created_at,
        sharedChannels: row.shared_channels,
      },
    });
  } catch (err) {
    console.error('Get user card error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

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
         FROM files WHERE dm_message_id = ANY($1) ORDER BY id`,
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
