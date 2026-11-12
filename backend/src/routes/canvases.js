const express = require('express');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership } = require('../security');

const MAX_CONTENT_LENGTH = 100000;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title.length > 0 && title.length <= 120 ? title : null;
}

async function getCanvas(canvasId) {
  const result = await query(
    'SELECT id, channel_id, title, content, created_at, updated_at FROM channel_canvases WHERE id = $1',
    [canvasId]
  );
  if (result.rows.length === 0) {
    const err = new Error('Canvas not found');
    err.status = 404;
    throw err;
  }
  return result.rows[0];
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
    const result = await query(
      `SELECT id, channel_id, title, created_at, updated_at
       FROM channel_canvases
       WHERE channel_id = $1
       ORDER BY updated_at DESC, id DESC`,
      [channelId]
    );
    // canvases someone shared into this channel (from the Canvas section) belong in the channel's list too
    const shared = await query(
      `SELECT c.id, c.title, c.created_at, c.updated_at, g.role
       FROM canvas_channel_grants g JOIN canvases c ON c.id = g.canvas_id
       WHERE g.channel_id = $1 AND c.kind = 'standalone' AND c.deleted_at IS NULL`,
      [channelId]
    );
    const canvases = [
      ...result.rows.map((canvas) => ({
        id: canvas.id,
        channelId: canvas.channel_id,
        title: canvas.title,
        createdAt: canvas.created_at,
        updatedAt: canvas.updated_at,
      })),
      ...shared.rows.map((canvas) => ({
        id: canvas.id,
        channelId,
        title: canvas.title,
        createdAt: canvas.created_at,
        updatedAt: canvas.updated_at,
        shared: true,
        role: canvas.role,
      })),
    ].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ canvases });
  } catch (err) {
    handleError(res, err, 'Get canvases error');
  }
});

router.get('/:canvasId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const canvas = await getCanvas(canvasId);
    await ensureChannelMembership(query, req.user.userId, canvas.channel_id);
    res.json({
      canvas: {
        id: canvas.id,
        channelId: canvas.channel_id,
        title: canvas.title,
        content: canvas.content,
        createdAt: canvas.created_at,
        updatedAt: canvas.updated_at,
      },
    });
  } catch (err) {
    handleError(res, err, 'Get canvas error');
  }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    const channelId = parseId(body.channelId);
    const title = parseTitle(body.title);
    const content = body.content === undefined ? '' : body.content;
    if (channelId === null) {
      return res.status(400).json({ error: 'A valid channel ID is required' });
    }
    if (!title) return res.status(400).json({ error: 'Canvas title must be between 1 and 120 characters' });
    if (typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) {
      return res.status(400).json({ error: 'Canvas content must be text no longer than 100,000 characters' });
    }
    await ensureChannelMembership(query, req.user.userId, channelId);

    const result = await query(
      `INSERT INTO channel_canvases (channel_id, title, content, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, channel_id, title, content, created_at, updated_at`,
      [channelId, title, content, req.user.userId]
    );
    const canvas = result.rows[0];
    res.status(201).json({
      canvas: {
        id: canvas.id,
        channelId: canvas.channel_id,
        title: canvas.title,
        content: canvas.content,
        createdAt: canvas.created_at,
        updatedAt: canvas.updated_at,
      },
    });
  } catch (err) {
    handleError(res, err, 'Create canvas error');
  }
});

router.put('/:canvasId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    const title = parseTitle(body.title);
    if (!title) return res.status(400).json({ error: 'Canvas title must be between 1 and 120 characters' });
    if (typeof body.content !== 'string' || body.content.length > MAX_CONTENT_LENGTH) {
      return res.status(400).json({ error: 'Canvas content must be text no longer than 100,000 characters' });
    }
    const canvas = await getCanvas(canvasId);
    await ensureChannelMembership(query, req.user.userId, canvas.channel_id);
    const result = await query(
      `UPDATE channel_canvases
       SET title = $1, content = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, channel_id, title, content, updated_at`,
      [title, body.content, canvasId]
    );
    const updated = result.rows[0];
    res.json({
      canvas: {
        id: updated.id,
        channelId: updated.channel_id,
        title: updated.title,
        content: updated.content,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err) {
    handleError(res, err, 'Update canvas error');
  }
});

router.delete('/:canvasId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const canvas = await getCanvas(canvasId);
    await ensureChannelMembership(query, req.user.userId, canvas.channel_id);
    await query('DELETE FROM channel_canvases WHERE id = $1', [canvasId]);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Delete canvas error');
  }
});

module.exports = router;
