const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership, ensureChannelModerator } = require('../security');

// Shared links (bookmarks) for a channel, shown in its Links tab.
// Mounted on /api/channels alongside the main channel routes.
const router = express.Router();

const MAX_LINKS = 50;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

// Accepts only absolute http(s) URLs. Returns the normalised URL or null.
function normalizeLinkUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.toString();
}

function serialize(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    title: row.title,
    url: row.url,
    createdBy: row.created_by,
    createdByUsername: row.username || 'former user',
    createdAt: row.created_at,
  };
}

router.get('/:channelId/links', authenticateToken, async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    await ensureChannelMembership(query, req.user.userId, channelId);
    const result = await query(
      `SELECT l.*, u.username FROM channel_links l
       LEFT JOIN users u ON u.id = l.created_by
       WHERE l.channel_id = $1 ORDER BY l.created_at`,
      [channelId]
    );
    res.json({ links: result.rows.map(serialize) });
  } catch (err) {
    sendError(res, err, 'List channel links error');
  }
});

router.post('/:channelId/links', authenticateToken, async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    await ensureChannelMembership(query, req.user.userId, channelId);
    const url = normalizeLinkUrl(req.body?.url);
    if (!url) return res.status(400).json({ error: 'Enter a full web address starting with http:// or https://' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (title.length > 120) return res.status(400).json({ error: 'Title must be 120 characters or fewer' });

    const count = await query('SELECT COUNT(*)::int AS count FROM channel_links WHERE channel_id = $1', [channelId]);
    if (count.rows[0].count >= MAX_LINKS) {
      return res.status(400).json({ error: `A channel can have at most ${MAX_LINKS} links` });
    }
    const created = await query(
      `INSERT INTO channel_links (channel_id, title, url, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [channelId, title || new URL(url).hostname, url, req.user.userId]
    );
    const row = await query(
      `SELECT l.*, u.username FROM channel_links l LEFT JOIN users u ON u.id = l.created_by WHERE l.id = $1`,
      [created.rows[0].id]
    );
    const link = serialize(row.rows[0]);
    req.io?.to(`channel_${channelId}`).emit('channel_links_updated', { channelId });
    res.status(201).json({ link });
  } catch (err) {
    sendError(res, err, 'Add channel link error');
  }
});

// The person who added a link, or a channel moderator, can remove it.
router.delete('/:channelId/links/:linkId', authenticateToken, async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    const linkId = parseId(req.params.linkId);
    await ensureChannelMembership(query, req.user.userId, channelId);
    if (!linkId) return res.status(400).json({ error: 'A valid link ID is required' });
    const link = await query(
      'SELECT created_by FROM channel_links WHERE id = $1 AND channel_id = $2',
      [linkId, channelId]
    );
    if (!link.rows.length) return res.status(404).json({ error: 'Link not found' });
    if (Number(link.rows[0].created_by) !== Number(req.user.userId)) {
      await ensureChannelModerator(query, req.user.userId, channelId);
    }
    await query('DELETE FROM channel_links WHERE id = $1', [linkId]);
    req.io?.to(`channel_${channelId}`).emit('channel_links_updated', { channelId });
    res.json({ removed: true });
  } catch (err) {
    sendError(res, err, 'Remove channel link error');
  }
});

module.exports = router;
module.exports.normalizeLinkUrl = normalizeLinkUrl;
