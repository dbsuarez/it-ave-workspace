const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership, ensureDirectMessageAccess, ensureCanvasAccess, getCanvasById } = require('../security');
const { ensureNotGuest } = require('../guests');
const { describeSections, applyOperation } = require('../canvasSections');

const MAX_CONTENT_LENGTH = 100000;
const MAX_TITLE_LENGTH = 160;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function parseTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title.length > 0 && title.length <= MAX_TITLE_LENGTH ? title : null;
}
function parseContent(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_CONTENT_LENGTH) {
    const err = new Error('Canvas content must be text no longer than 100,000 characters');
    err.status = 400;
    throw err;
  }
  return value;
}

// baseRevision is optional so older clients keep working (last write wins for them). When given,
// it must be a positive integer.
function parseBaseRevision(value) {
  if (value === undefined || value === null) return null;
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    const err = new Error('baseRevision must be a positive whole number');
    err.status = 400;
    throw err;
  }
  return revision;
}

// One conditional UPDATE: it only applies when baseRevision still matches, so two people saving
// from the same starting point cannot silently overwrite each other. On a mismatch nothing is
// written and the caller gets the current canvas back with HTTP 409.
async function saveCanvasChanges(canvasId, title, content, baseRevision) {
  const result = await query(
    `UPDATE canvases
     SET title = COALESCE($1, title),
         content = COALESCE($2, content),
         revision = revision + 1,
         updated_at = NOW()
     WHERE id = $3 AND ($4::int IS NULL OR revision = $4)
     RETURNING id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision`,
    [title, content, canvasId, baseRevision]
  );
  if (result.rows[0]) return { canvas: result.rows[0] };
  const current = await query(
    `SELECT id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision
     FROM canvases WHERE id = $1`,
    [canvasId]
  );
  return { conflict: current.rows[0] || null };
}

function conflictResponse(res, current, extras = {}) {
  if (!current) return res.status(404).json({ error: 'Canvas not found' });
  return res.status(409).json({
    error: 'Someone else changed this canvas since you opened it',
    code: 'revision_conflict',
    canvas: mapCanvas(current, extras),
  });
}

async function getChannelCanvas(channelId) {
  const result = await query(
    `SELECT id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision
     FROM canvases
     WHERE kind = 'channel' AND channel_id = $1`,
    [channelId]
  );
  return result.rows[0] || null;
}
async function getDmCanvas(a, b) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  const result = await query(
    `SELECT id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision
     FROM canvases
     WHERE kind = 'dm' AND dm_user_low = $1 AND dm_user_high = $2`,
    [low, high]
  );
  return result.rows[0] || null;
}
async function getOrCreateChannelCanvas(channelId, userId) {
  let canvas = await getChannelCanvas(channelId);
  if (canvas) return canvas;
  const result = await query(
    `INSERT INTO canvases (kind, channel_id, title, content, created_by)
     VALUES ('channel', $1, $2, '', $3)
     ON CONFLICT (channel_id) WHERE kind = 'channel' DO NOTHING
     RETURNING id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision`,
    [channelId, '#' + channelId, userId]
  );
  if (result.rows[0]) return result.rows[0];
  canvas = await getChannelCanvas(channelId);
  return canvas;
}
async function getOrCreateDmCanvas(a, b) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  let canvas = await getDmCanvas(low, high);
  if (canvas) return canvas;
  const result = await query(
    `INSERT INTO canvases (kind, dm_user_low, dm_user_high, title, content, created_by)
     VALUES ('dm', $1, $2, $3, '', $4)
     ON CONFLICT (dm_user_low, dm_user_high) WHERE kind = 'dm' DO NOTHING
     RETURNING id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision`,
    [low, high, 'DM', low]
  );
  if (result.rows[0]) return result.rows[0];
  canvas = await getDmCanvas(low, high);
  return canvas;
}

function mapCanvas(c, extras = {}) {
  return {
    id: c.id,
    kind: c.kind,
    channelId: c.channel_id,
    dmUserLow: c.dm_user_low,
    dmUserHigh: c.dm_user_high,
    title: c.title,
    content: c.content,
    createdBy: c.created_by,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    revision: c.revision === undefined ? undefined : Number(c.revision),
    ...extras,
  };
}

// GET /api/canvas/channel/:channelId - primary channel canvas (auto-created lazily)
router.get('/channel/:channelId', authenticateToken, async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    if (channelId === null) return res.status(400).json({ error: 'A valid channel ID is required' });
    await ensureChannelMembership(query, req.user.userId, channelId);
    const canvas = await getOrCreateChannelCanvas(channelId, req.user.userId);
    res.json({ canvas: mapCanvas(canvas) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Channel canvas read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/canvas/dm/:userId - primary canvas for the DM with user :userId
router.get('/dm/:userId', authenticateToken, async (req, res) => {
  try {
    const otherId = parseId(req.params.userId);
    if (otherId === null) return res.status(400).json({ error: 'A valid user ID is required' });
    await ensureDirectMessageAccess(query, req.user.userId, otherId);
    const canvas = await getOrCreateDmCanvas(req.user.userId, otherId);
    res.json({ canvas: mapCanvas(canvas) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DM canvas read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/canvas/standalone - canvases the current user owns or collaborates on
router.get('/standalone', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.kind, c.channel_id, c.dm_user_low, c.dm_user_high, c.title, c.content, c.created_by,
              c.created_at, c.updated_at, c.revision,
              (SELECT role FROM canvas_collaborators WHERE canvas_id = c.id AND user_id = $1) AS my_role
       FROM canvases c
       WHERE c.kind = 'standalone'
         AND (c.created_by = $1
              OR EXISTS (SELECT 1 FROM canvas_collaborators WHERE canvas_id = c.id AND user_id = $1))
       ORDER BY c.updated_at DESC, c.id DESC`,
      [req.user.userId]
    );
    res.json({
      canvases: result.rows.map((c) => mapCanvas(c, { myRole: c.my_role })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Standalone canvases list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/canvas - create a standalone canvas
router.post('/', authenticateToken, async (req, res) => {
  try {
    const title = parseTitle(req.body?.title);
    const content = parseContent(req.body?.content);
    if (!title) return res.status(400).json({ error: 'Canvas title must be between 1 and 160 characters' });
    await ensureNotGuest(query, req.user.userId, 'Guests cannot create canvases');
    const result = await query(
      `INSERT INTO canvases (kind, title, content, created_by)
       VALUES ('standalone', $1, $2, $3)
       RETURNING id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision`,
      [title, content, req.user.userId]
    );
    res.status(201).json({ canvas: mapCanvas(result.rows[0], { myRole: 'owner' }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Create canvas error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/canvas/:id - open canvas (role-gated)
router.get('/:canvasId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'viewer');
    let myRole = 'owner';
    if (canvas.kind === 'standalone' && Number(canvas.created_by) !== Number(req.user.userId)) {
      const collab = await query(
        'SELECT role FROM canvas_collaborators WHERE canvas_id = $1 AND user_id = $2',
        [canvasId, req.user.userId]
      );
      myRole = collab.rows[0]?.role || 'viewer';
    }
    res.json({ canvas: mapCanvas(canvas, { myRole }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Canvas read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/canvas/:id/sections?type=&contains= - the document's top-level blocks. The ids are only
// valid for the returned revision; send it back as baseRevision with an operation.
router.get('/:canvasId/sections', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'viewer');
    const type = typeof req.query.type === 'string' && req.query.type ? req.query.type : undefined;
    const contains = typeof req.query.contains === 'string' && req.query.contains ? req.query.contains.slice(0, 200) : undefined;
    res.json({
      canvasId,
      revision: Number(canvas.revision),
      sections: describeSections(canvas.content, { type, contains }),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Canvas sections error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function applyCanvasOperation(req, res, canvasId) {
  if (req.body.title !== undefined || req.body.content !== undefined) {
    return res.status(400).json({ error: 'Send either an operation or title/content, not both' });
  }
  const baseRevision = parseBaseRevision(req.body.baseRevision);
  if (baseRevision === null) {
    return res.status(400).json({ error: 'baseRevision is required with an operation (section ids belong to one revision)' });
  }
  const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
  if (Number(canvas.revision) !== baseRevision) return conflictResponse(res, canvas);
  const change = applyOperation(canvas.content, req.body.operation);
  // The same conditional save as everyone else: if another save slipped in meanwhile it is a 409.
  const saved = await saveCanvasChanges(canvasId, change.title, change.content, baseRevision);
  if (!saved.canvas) return conflictResponse(res, saved.conflict);
  req.io?.to(`canvas:${canvasId}`).emit('canvas_updated', {
    canvasId, kind: saved.canvas.kind, title: saved.canvas.title, content: saved.canvas.content,
    revision: Number(saved.canvas.revision), updatedAt: saved.canvas.updated_at,
  });
  return res.json({ canvas: mapCanvas(saved.canvas) });
}

// PATCH /api/canvas/:id - update title/content, or apply ONE section operation
// ({ operation: { op, sectionId?, markdown?, item?, checked?, title? }, baseRevision }).
router.patch('/:canvasId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    if (req.body?.operation !== undefined) return await applyCanvasOperation(req, res, canvasId);
    const title = req.body?.title === undefined ? null : parseTitle(req.body.title);
    if (req.body?.title !== undefined && title === null) {
      return res.status(400).json({ error: 'Canvas title must be between 1 and 160 characters' });
    }
    const content = req.body?.content === undefined ? null : parseContent(req.body.content);
    const baseRevision = parseBaseRevision(req.body?.baseRevision);
    await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    const saved = await saveCanvasChanges(canvasId, title, content, baseRevision);
    if (!saved.canvas) return conflictResponse(res, saved.conflict);
    const result = { rows: [saved.canvas] };
    req.io?.to(`canvas:${canvasId}`).emit('canvas_updated', {
      canvasId, kind: result.rows[0].kind, title: result.rows[0].title, content: result.rows[0].content,
      revision: Number(result.rows[0].revision), updatedAt: result.rows[0].updated_at,
    });
    res.json({ canvas: mapCanvas(result.rows[0]) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Canvas update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/canvas/:id - delete; owner only for standalone, creator or mod/superadmin for others
router.delete('/:canvasId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    // Channel: creator or channel moderator or superadmin; DM: creator only; standalone: owner only
    if (canvas.kind === 'channel') {
      const allowed = Number(canvas.created_by) === Number(req.user.userId);
      if (!allowed) {
        const mod = await query(
          `SELECT 1 FROM users u WHERE u.id = $2 AND (
             u.is_superadmin = TRUE
             OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = $1 AND cm.user_id = u.id AND cm.role = 'moderator')
           )`,
          [canvas.channel_id, req.user.userId]
        );
        if (mod.rows.length === 0) return res.status(403).json({ error: 'Only the creator, a channel moderator or the Superadmin can delete this canvas' });
      }
    } else if (canvas.kind === 'dm') {
      if (Number(canvas.created_by) !== Number(req.user.userId)) {
        return res.status(403).json({ error: 'Only the creator can delete this canvas' });
      }
    } else {
      if (Number(canvas.created_by) !== Number(req.user.userId)) {
        return res.status(403).json({ error: 'Only the owner can delete this canvas' });
      }
    }
    await query('DELETE FROM canvases WHERE id = $1', [canvasId]);
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Delete canvas error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/canvas/:id/collaborators - add a collaborator by username
router.post('/:canvasId/collaborators', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : null;
    if (!username) return res.status(400).json({ error: 'Username is required' });
    const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    if (canvas.kind !== 'standalone') return res.status(400).json({ error: 'Only standalone canvases can have collaborators' });
    if (Number(canvas.created_by) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can add collaborators' });
    const user = await query('SELECT id, username FROM users WHERE LOWER(username) = $1', [username]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (Number(user.rows[0].id) === Number(req.user.userId)) return res.status(400).json({ error: 'You already own this canvas' });
    await query(
      `INSERT INTO canvas_collaborators (canvas_id, user_id, role, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (canvas_id, user_id) DO NOTHING`,
      [canvasId, user.rows[0].id, role, req.user.userId]
    );
    res.json({ collaborator: { userId: user.rows[0].id, username: user.rows[0].username, role } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Add collaborator error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/canvas/:id/collaborators/:userId - remove a collaborator
router.delete('/:canvasId/collaborators/:userId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    const userId = parseId(req.params.userId);
    if (canvasId === null || userId === null) return res.status(400).json({ error: 'Canvas and user IDs must be valid numbers' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    if (canvas.kind !== 'standalone') return res.status(400).json({ error: 'Only standalone canvases can have collaborators' });
    if (Number(canvas.created_by) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can remove collaborators' });
    await query(
      'DELETE FROM canvas_collaborators WHERE canvas_id = $1 AND user_id = $2',
      [canvasId, userId]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Remove collaborator error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/canvas/:id/collaborators - list collaborators
router.get('/:canvasId/collaborators', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    await ensureCanvasAccess(query, req.user.userId, canvasId, 'viewer');
    const result = await query(
      `SELECT u.id, u.username, cc.role, cc.created_at
       FROM canvas_collaborators cc
       JOIN users u ON u.id = cc.user_id
       WHERE cc.canvas_id = $1
       ORDER BY u.username`,
      [canvasId]
    );
    res.json({
      collaborators: result.rows.map((c) => ({
        id: c.id, username: c.username, role: c.role, createdAt: c.created_at,
      })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('List collaborators error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/canvas/:id/shares - generate a share token
router.post('/:canvasId/shares', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    if (canvas.kind !== 'standalone') return res.status(400).json({ error: 'Only standalone canvases can be shared by link' });
    if (Number(canvas.created_by) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can create share links' });
    const token = crypto.randomBytes(18).toString('base64url');
    const result = await query(
      `INSERT INTO canvas_shares (canvas_id, token, role, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, canvas_id, token, role, created_at, expires_at`,
      [canvasId, token, role, req.user.userId]
    );
    const row = result.rows[0];
    res.status(201).json({
      share: {
        id: row.id, canvasId: row.canvas_id, token: row.token, role: row.role,
        createdAt: row.created_at, expiresAt: row.expires_at,
        url: `${req.protocol}://${req.get('host')}/api/canvas/share/${token}`,
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Create share error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/canvas/:id/shares/:shareId - revoke a share link
router.delete('/:canvasId/shares/:shareId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    const shareId = parseId(req.params.shareId);
    if (canvasId === null || shareId === null) return res.status(400).json({ error: 'Canvas and share IDs must be valid numbers' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    if (Number(canvas.created_by) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can revoke share links' });
    await query(
      'DELETE FROM canvas_shares WHERE id = $1 AND canvas_id = $2',
      [shareId, canvasId]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Revoke share error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/canvas/share/:token - open a shared canvas (no auth required to read, edit requires editor role on the share)
router.get('/share/:token', authenticateToken, async (req, res) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token : null;
    if (!token || token.length > 256) return res.status(400).json({ error: 'Invalid share token' });
    const result = await query(
      `SELECT cs.id AS share_id, cs.role, cs.canvas_id, cs.expires_at, c.*
       FROM canvas_shares cs
       JOIN canvases c ON c.id = cs.canvas_id
       WHERE cs.token = $1`,
      [token]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Share link not found' });
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Share link expired' });
    res.json({ canvas: mapCanvas(row, { myRole: row.role }) });
  } catch (err) {
    console.error('Read share error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/canvas/share/:token - edit via share link (editor role required)
router.patch('/share/:token', authenticateToken, async (req, res) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token : null;
    if (!token || token.length > 256) return res.status(400).json({ error: 'Invalid share token' });
    const title = req.body?.title === undefined ? null : parseTitle(req.body.title);
    if (req.body?.title !== undefined && title === null) {
      return res.status(400).json({ error: 'Canvas title must be between 1 and 160 characters' });
    }
    const content = req.body?.content === undefined ? null : parseContent(req.body.content);
    const baseRevision = parseBaseRevision(req.body?.baseRevision);
    const shareResult = await query(
      'SELECT id, canvas_id, role FROM canvas_shares WHERE token = $1',
      [token]
    );
    const share = shareResult.rows[0];
    if (!share) return res.status(404).json({ error: 'Share link not found' });
    if (share.role !== 'editor') return res.status(403).json({ error: 'This share link is read-only' });
    const saved = await saveCanvasChanges(share.canvas_id, title, content, baseRevision);
    if (!saved.canvas) return conflictResponse(res, saved.conflict, { myRole: 'editor' });
    const result = { rows: [saved.canvas] };
    req.io?.to(`canvas:${share.canvas_id}`).emit('canvas_updated', {
      canvasId: share.canvas_id, kind: saved.canvas.kind, title: saved.canvas.title, content: saved.canvas.content,
      revision: Number(saved.canvas.revision), updatedAt: saved.canvas.updated_at,
    });
    res.json({ canvas: mapCanvas(result.rows[0], { myRole: 'editor' }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Update shared canvas error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
