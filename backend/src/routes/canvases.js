// GET /api/canvases?channelId= - the canvases shared into a channel (shown on the channel's Canvases tab).
// The old Wiki (Markdown pages that belonged to a channel) was retired; the empty channel_canvases table is left in the database.
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership } = require('../security');

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function handleError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    const channelId = parseId(req.query.channelId);
    if (channelId === null) {
      return res.status(400).json({ error: 'A valid channel ID is required' });
    }
    await ensureChannelMembership(query, req.user.userId, channelId);
    // canvases someone shared into this channel (from the Canvas section)
    const shared = await query(
      `SELECT c.id, c.title, c.created_at, c.updated_at, g.role,
              u.id AS owner_id, u.username AS owner_username, u.first_name AS owner_first_name,
              u.middle_name AS owner_middle_name, u.last_name AS owner_last_name,
              u.avatar_color AS owner_avatar_color, u.photo_updated_at AS owner_photo_updated_at
       FROM canvas_channel_grants g JOIN canvases c ON c.id = g.canvas_id
       LEFT JOIN users u ON u.id = c.owner_id
       WHERE g.channel_id = $1 AND c.kind = 'standalone' AND c.deleted_at IS NULL`,
      [channelId]
    );
    const canvases = shared.rows.map((canvas) => ({
      id: canvas.id,
      channelId,
      title: canvas.title,
      createdAt: canvas.created_at,
      updatedAt: canvas.updated_at,
      shared: true,
      role: canvas.role,
      owner: canvas.owner_id ? {
        id: canvas.owner_id,
        username: canvas.owner_username,
        name: [canvas.owner_first_name, canvas.owner_middle_name, canvas.owner_last_name].filter(Boolean).join(' ') || canvas.owner_username,
        avatarColor: /^#[0-9a-f]{6}$/i.test(canvas.owner_avatar_color || '') ? canvas.owner_avatar_color : '',
        photoVersion: canvas.owner_photo_updated_at ? new Date(canvas.owner_photo_updated_at).getTime() : null,
      } : null,
    })).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ canvases });
  } catch (err) {
    handleError(res, err, 'Get canvases error');
  }
});

module.exports = router;
