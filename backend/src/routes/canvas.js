const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const {
  ensureChannelMembership, ensureDirectMessageAccess, ensureCanvasAccess, getCanvasById,
  canvasOwnerId, getStandaloneCanvasRole,
} = require('../security');
const { ensureNotGuest } = require('../guests');
const { describeSections, applyOperation } = require('../canvasSections');
const config = require('../config');
const { checkUploadedFile, mimeForFilename } = require('../uploadContent');
const canvasMentions = require('../canvasMentions');

// Images inside a canvas: pictures only (SVG is left out: it can carry script), a cap per canvas.
const CANVAS_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_IMAGES_PER_CANVAS = 50;
const MAX_IMAGE_MB = Math.min(config.MAX_FILE_SIZE_MB, 10);

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
      cb(null, config.UPLOAD_DIR);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
  }),
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (/\.([A-Za-z0-9]+)$/.exec(file.originalname || '') || [])[1];
    if (!ext || !CANVAS_IMAGE_EXTENSIONS.has(ext.toLowerCase())) {
      return cb(new Error('Only PNG, JPG, GIF or WebP images can be added to a canvas'));
    }
    cb(null, true);
  },
});

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
const REVISION_WINDOW_MS = 60 * 1000; // saves by one person within a minute share one history entry
const MAX_REVISIONS = 100;

// Keeps a short history. Autosave fires every few seconds while typing, so consecutive saves by the
// same person within a minute are folded into one entry instead of flooding the list. A failure here
// never fails the save itself.
async function recordRevision(canvas, userId, { newEntry = false } = {}) {
  try {
    const last = (await query(
      'SELECT id, edited_by, edited_at FROM canvas_revisions WHERE canvas_id = $1 ORDER BY revision DESC LIMIT 1',
      [canvas.id]
    )).rows[0];
    const recent = !newEntry && last && Number(last.edited_by) === Number(userId)
      && Date.now() - new Date(last.edited_at).getTime() < REVISION_WINDOW_MS;
    if (recent) {
      await query(
        'UPDATE canvas_revisions SET revision = $2, title = $3, content = $4, edited_at = NOW() WHERE id = $1',
        [last.id, canvas.revision, canvas.title, canvas.content]
      );
    } else {
      await query(
        'INSERT INTO canvas_revisions (canvas_id, revision, title, content, edited_by) VALUES ($1, $2, $3, $4, $5)',
        [canvas.id, canvas.revision, canvas.title, canvas.content, userId]
      );
      await query(
        `DELETE FROM canvas_revisions WHERE canvas_id = $1 AND id NOT IN (
           SELECT id FROM canvas_revisions WHERE canvas_id = $1 ORDER BY revision DESC LIMIT ${MAX_REVISIONS})`,
        [canvas.id]
      );
    }
  } catch (err) {
    console.error('Canvas history error:', err.message);
  }
}

async function saveCanvasChanges(canvasId, title, content, baseRevision, userId, options = {}) {
  const result = await query(
    `UPDATE canvases
     SET title = COALESCE($1, title),
         content = COALESCE($2, content),
         revision = revision + 1,
         updated_at = NOW()
     WHERE id = $3 AND deleted_at IS NULL AND ($4::int IS NULL OR revision = $4)
     RETURNING id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision, owner_id`,
    [title, content, canvasId, baseRevision]
  );
  if (result.rows[0]) {
    await recordRevision(result.rows[0], userId, options);
    return { canvas: result.rows[0] };
  }
  const current = await query(
    `SELECT id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision, owner_id
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
    `SELECT id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision, owner_id
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
    `SELECT id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision, owner_id
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
     RETURNING id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision, owner_id`,
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
     RETURNING id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision, owner_id`,
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
    ownerId: c.kind === 'standalone' ? canvasOwnerId(c) : undefined,
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
    const userId = req.user.userId;
    const result = await query(
      `SELECT c.id, c.kind, c.channel_id, c.dm_user_low, c.dm_user_high, c.title, c.content, c.created_by,
              c.created_at, c.updated_at, c.revision, c.owner_id
       FROM canvases c
       WHERE c.kind = 'standalone' AND c.deleted_at IS NULL
         AND (COALESCE(c.owner_id, c.created_by) = $1
              OR EXISTS (SELECT 1 FROM canvas_collaborators WHERE canvas_id = c.id AND user_id = $1)
              OR EXISTS (SELECT 1 FROM canvas_channel_grants g
                         JOIN channel_members cm ON cm.channel_id = g.channel_id
                         WHERE g.canvas_id = c.id AND cm.user_id = $1))
       ORDER BY c.updated_at DESC, c.id DESC`,
      [userId]
    );
    const canvases = [];
    for (const row of result.rows) {
      const myRole = await getStandaloneCanvasRole(query, userId, row);
      if (myRole) canvases.push(mapCanvas(row, { myRole }));
    }
    res.json({ canvases });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Standalone canvases list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/canvas/deleted - the caller's own deleted personal canvases that can still be restored
router.get('/deleted', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, title, LEFT(content, 160) AS preview, deleted_at,
              deleted_at + ($2::int * INTERVAL '1 day') AS expires_at
       FROM canvases
       WHERE kind = 'standalone' AND deleted_at IS NOT NULL
         AND deleted_at > NOW() - ($2::int * INTERVAL '1 day')
         AND COALESCE(owner_id, created_by) = $1
       ORDER BY deleted_at DESC, id DESC`,
      [req.user.userId, config.CANVAS_TRASH_DAYS]
    );
    res.json({
      retentionDays: config.CANVAS_TRASH_DAYS,
      canvases: result.rows.map((row) => ({
        id: row.id, title: row.title, preview: row.preview, deletedAt: row.deleted_at, expiresAt: row.expires_at,
      })),
    });
  } catch (err) {
    console.error('Deleted canvases list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/canvas/:id/restore - bring one of your deleted personal canvases back
router.post('/:canvasId/restore', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const found = await query(
      `SELECT id, kind, owner_id, created_by, deleted_at,
              (deleted_at > NOW() - ($2::int * INTERVAL '1 day')) AS restorable
       FROM canvases WHERE id = $1`,
      [canvasId, config.CANVAS_TRASH_DAYS]
    );
    const row = found.rows[0];
    // the same answer for "no such canvas", "not deleted" and "not yours": nothing to restore
    if (!row || row.kind !== 'standalone' || !row.deleted_at || canvasOwnerId(row) !== Number(req.user.userId)) {
      return res.status(404).json({ error: 'Canvas not found' });
    }
    if (!row.restorable) return res.status(410).json({ error: 'This canvas was deleted too long ago to restore' });
    await query('UPDATE canvases SET deleted_at = NULL, deleted_by = NULL WHERE id = $1', [canvasId]);
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'viewer');
    res.json({ canvas: mapCanvas(canvas, { myRole: 'owner' }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Restore canvas error:', err);
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
      `INSERT INTO canvases (kind, title, content, created_by, owner_id)
       VALUES ('standalone', $1, $2, $3, $3)
       RETURNING id, kind, channel_id, dm_user_low, dm_user_high, title, content, created_by, created_at, updated_at, revision, owner_id`,
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
    const myRole = canvas.kind === 'standalone'
      ? await getStandaloneCanvasRole(query, req.user.userId, canvas)
      : 'editor';
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
      sections: describeSections(canvas.content, { type, contains, full: req.query.full === 'true' }),
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
  const saved = await saveCanvasChanges(canvasId, change.title, change.content, baseRevision, req.user.userId);
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
    const before = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    const saved = await saveCanvasChanges(canvasId, title, content, baseRevision, req.user.userId);
    if (!saved.canvas) return conflictResponse(res, saved.conflict);
    const result = { rows: [saved.canvas] };
    if (content !== null) {
      // new @mentions in the text notify those people (never blocks or fails the save)
      canvasMentions.notifyMentions({
        query, io: req.io, canvas: saved.canvas, actorId: req.user.userId, text: content,
        usernames: canvasMentions.addedMentions(before.content, content), source: 'content',
      }).catch((err) => console.error('Canvas mention notify error:', err.message));
    }
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
// ---- comments -----------------------------------------------------------------------------------
// Threads: a top-level comment (optionally quoting the passage it is about) and flat replies. Anyone who
// can read the canvas can read them; editors can write, reply and resolve. The author, or the canvas
// owner/creator, can delete a comment (deleting a top-level one removes its replies).

const MAX_COMMENT_LENGTH = 2000;
const MAX_ANCHOR_LENGTH = 200;
const MAX_COMMENTS_PER_CANVAS = 500;

function mapComment(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    body: row.body,
    anchor: row.anchor,
    author: row.user_id ? { id: row.user_id, username: row.username } : null,
    createdAt: row.created_at,
    resolved: Boolean(row.resolved_at),
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by ? { id: row.resolved_by, username: row.resolved_by_username } : null,
  };
}

const COMMENT_SELECT = `SELECT c.id, c.parent_id, c.body, c.anchor, c.user_id, u.username, c.created_at,
        c.resolved_at, c.resolved_by, r.username AS resolved_by_username
   FROM canvas_comments c
   LEFT JOIN users u ON u.id = c.user_id
   LEFT JOIN users r ON r.id = c.resolved_by`;

function notifyComments(req, canvasId) {
  req.io?.to(`canvas:${canvasId}`).emit('canvas_comments_updated', { canvasId });
}

router.get('/:canvasId/comments', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    await ensureCanvasAccess(query, req.user.userId, canvasId, 'viewer');
    const result = await query(`${COMMENT_SELECT} WHERE c.canvas_id = $1 ORDER BY c.created_at, c.id`, [canvasId]);
    res.json({ comments: result.rows.map(mapComment) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('List canvas comments error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:canvasId/comments', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body || body.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ error: `A comment must be 1 to ${MAX_COMMENT_LENGTH} characters` });
    }
    let anchor = null;
    if (req.body.anchor !== undefined && req.body.anchor !== null) {
      if (typeof req.body.anchor !== 'string') return res.status(400).json({ error: 'anchor must be text' });
      anchor = req.body.anchor.trim().slice(0, MAX_ANCHOR_LENGTH) || null;
    }
    let parentId = null;
    if (req.body.parentId !== undefined && req.body.parentId !== null) {
      parentId = parseId(req.body.parentId);
      if (parentId === null) return res.status(400).json({ error: 'parentId must be a valid comment ID' });
      const parent = await query('SELECT id, parent_id FROM canvas_comments WHERE id = $1 AND canvas_id = $2', [parentId, canvasId]);
      if (parent.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
      if (parent.rows[0].parent_id) return res.status(400).json({ error: 'Reply to the top-level comment of the thread' });
      anchor = null;
    }
    const count = await query('SELECT COUNT(*) AS n FROM canvas_comments WHERE canvas_id = $1', [canvasId]);
    if (Number(count.rows[0].n) >= MAX_COMMENTS_PER_CANVAS) {
      return res.status(400).json({ error: `A canvas can hold at most ${MAX_COMMENTS_PER_CANVAS} comments` });
    }
    const inserted = await query(
      `INSERT INTO canvas_comments (canvas_id, parent_id, user_id, body, anchor) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [canvasId, parentId, req.user.userId, body, anchor]
    );
    const row = await query(`${COMMENT_SELECT} WHERE c.id = $1`, [inserted.rows[0].id]);
    notifyComments(req, canvasId);
    res.status(201).json({ comment: mapComment(row.rows[0]) });
    // people mentioned in the comment, and the author of the thread being replied to, are told
    (async () => {
      const told = new Set();
      const mentioned = await canvasMentions.notifyMentions({
        query, io: req.io, canvas, actorId: req.user.userId, text: body, source: 'comment', snippet: body.slice(0, 160),
      });
      mentioned.forEach((id) => told.add(Number(id)));
      if (parentId) {
        const thread = await query('SELECT user_id FROM canvas_comments WHERE id = $1', [parentId]);
        const starter = thread.rows[0] && thread.rows[0].user_id;
        if (starter && !told.has(Number(starter))) {
          await canvasMentions.deliver({
            query, io: req.io, canvas, actorId: req.user.userId, userIds: [starter], source: 'reply', snippet: body.slice(0, 160),
          });
        }
      }
    })().catch((err) => console.error('Canvas comment notify error:', err.message));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Add canvas comment error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Resolve or reopen a thread (the top-level comment).
router.patch('/:canvasId/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    const commentId = parseId(req.params.commentId);
    if (canvasId === null || commentId === null) return res.status(400).json({ error: 'Canvas and comment IDs must be valid' });
    await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    if (typeof req.body.resolved !== 'boolean') return res.status(400).json({ error: 'resolved must be true or false' });
    const found = await query('SELECT id, parent_id FROM canvas_comments WHERE id = $1 AND canvas_id = $2', [commentId, canvasId]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
    if (found.rows[0].parent_id) return res.status(400).json({ error: 'Only a whole thread can be resolved' });
    await query(
      'UPDATE canvas_comments SET resolved_at = $1, resolved_by = $2 WHERE id = $3',
      [req.body.resolved ? new Date() : null, req.body.resolved ? req.user.userId : null, commentId]
    );
    const row = await query(`${COMMENT_SELECT} WHERE c.id = $1`, [commentId]);
    notifyComments(req, canvasId);
    res.json({ comment: mapComment(row.rows[0]) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Resolve canvas comment error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:canvasId/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    const commentId = parseId(req.params.commentId);
    if (canvasId === null || commentId === null) return res.status(400).json({ error: 'Canvas and comment IDs must be valid' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    const found = await query('SELECT id, user_id FROM canvas_comments WHERE id = $1 AND canvas_id = $2', [commentId, canvasId]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
    const me = Number(req.user.userId);
    const mine = Number(found.rows[0].user_id) === me;
    const canvasAdmin = Number(canvas.created_by) === me || canvasOwnerId(canvas) === me;
    if (!mine && !canvasAdmin) return res.status(403).json({ error: 'Only the author or the canvas owner can delete a comment' });
    await query('DELETE FROM canvas_comments WHERE id = $1', [commentId]);
    notifyComments(req, canvasId);
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Delete canvas comment error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload an image to put inside this canvas (editor access). The text of the canvas refers to it as
// ![name](file:<id>); readers fetch it from /api/files/<id>/download, which follows the canvas's access.
router.post('/:canvasId/images', authenticateToken, async (req, res) => {
  const canvasId = parseId(req.params.canvasId);
  if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
  try {
    await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
  imageUpload.single('file')(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? `Images can be at most ${MAX_IMAGE_MB}MB` : (err.message || 'Invalid image upload') });
    }
    const discard = () => (req.file ? fs.promises.unlink(req.file.path).catch(() => {}) : Promise.resolve());
    try {
      if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
      const contentError = await checkUploadedFile(req.file.path, req.file.originalname);
      if (contentError) {
        await discard();
        return res.status(400).json({ error: contentError });
      }
      const count = await query('SELECT COUNT(*) AS n FROM files WHERE canvas_id = $1', [canvasId]);
      if (Number(count.rows[0].n) >= MAX_IMAGES_PER_CANVAS) {
        await discard();
        return res.status(400).json({ error: `A canvas can hold at most ${MAX_IMAGES_PER_CANVAS} images` });
      }
      const mime = mimeForFilename(req.file.originalname);
      const result = await query(
        `INSERT INTO files (canvas_id, filename, original_name, size, mime_type, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [canvasId, req.file.filename, req.file.originalname, req.file.size, mime, req.user.userId]
      );
      res.status(201).json({ fileId: result.rows[0].id, name: req.file.originalname, size: req.file.size, mimeType: mime });
    } catch (uploadErr) {
      await discard();
      console.error('Canvas image upload error:', uploadErr);
      res.status(500).json({ error: 'Server error during upload' });
    }
  });
});

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
      if (canvasOwnerId(canvas) !== Number(req.user.userId)) {
        return res.status(403).json({ error: 'Only the owner can delete this canvas' });
      }
    }
    if (canvas.kind === 'standalone') {
      // personal canvases go to the trash first, so a mistake can be undone (see GET /deleted, POST /:id/restore)
      await query('UPDATE canvases SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1', [canvasId, req.user.userId]);
      req.io?.to(`canvas:${canvasId}`).emit('canvas_deleted', { canvasId });
      return res.json({ success: true, restorable: true, retentionDays: config.CANVAS_TRASH_DAYS });
    }
    // channel and DM canvases are removed at once; their images go with them (rows cascade), so remove the files too
    const images = await query('SELECT filename FROM files WHERE canvas_id = $1', [canvasId]);
    await query('DELETE FROM canvases WHERE id = $1', [canvasId]);
    for (const row of images.rows || []) {
      fs.promises.unlink(path.join(config.UPLOAD_DIR, row.filename)).catch(() => {});
    }
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
    if (canvasOwnerId(canvas) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can add collaborators' });
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
    if (canvasOwnerId(canvas) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can remove collaborators' });
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

// ---- History ----------------------------------------------------------------------------------

// GET /api/canvas/:id/revisions - saved versions, newest first
router.get('/:canvasId/revisions', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    await ensureCanvasAccess(query, req.user.userId, canvasId, 'viewer');
    const result = await query(
      `SELECT r.revision, r.title, r.edited_at, r.edited_by, u.username, LENGTH(r.content) AS size
       FROM canvas_revisions r LEFT JOIN users u ON u.id = r.edited_by
       WHERE r.canvas_id = $1 ORDER BY r.revision DESC LIMIT ${MAX_REVISIONS}`,
      [canvasId]
    );
    res.json({
      revisions: result.rows.map((r) => ({
        revision: Number(r.revision), title: r.title, editedAt: r.edited_at, size: Number(r.size),
        editedBy: r.edited_by === null ? null : { id: r.edited_by, username: r.username },
      })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Canvas revisions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function loadRevision(canvasId, revision) {
  const result = await query(
    `SELECT r.revision, r.title, r.content, r.edited_at, r.edited_by, u.username
     FROM canvas_revisions r LEFT JOIN users u ON u.id = r.edited_by
     WHERE r.canvas_id = $1 AND r.revision = $2`,
    [canvasId, revision]
  );
  return result.rows[0] || null;
}

// GET /api/canvas/:id/revisions/:revision - one saved version with its text
router.get('/:canvasId/revisions/:revision', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    const revision = parseId(req.params.revision);
    if (canvasId === null || revision === null) return res.status(400).json({ error: 'Valid canvas and revision numbers are required' });
    await ensureCanvasAccess(query, req.user.userId, canvasId, 'viewer');
    const row = await loadRevision(canvasId, revision);
    if (!row) return res.status(404).json({ error: 'That version is no longer available' });
    res.json({
      revision: {
        revision: Number(row.revision), title: row.title, content: row.content, editedAt: row.edited_at,
        editedBy: row.edited_by === null ? null : { id: row.edited_by, username: row.username },
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Canvas revision read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/canvas/:id/revisions/:revision/restore - make an old version current again. It is saved as a
// NEW version (nothing is erased), so a restore can itself be undone from the history.
router.post('/:canvasId/revisions/:revision/restore', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    const revision = parseId(req.params.revision);
    if (canvasId === null || revision === null) return res.status(400).json({ error: 'Valid canvas and revision numbers are required' });
    await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    const row = await loadRevision(canvasId, revision);
    if (!row) return res.status(404).json({ error: 'That version is no longer available' });
    const baseRevision = parseBaseRevision(req.body?.baseRevision);
    // A restore always gets its own history entry, so the version it replaces is never folded away.
    const saved = await saveCanvasChanges(canvasId, row.title, row.content, baseRevision, req.user.userId, { newEntry: true });
    if (!saved.canvas) return conflictResponse(res, saved.conflict);
    req.io?.to(`canvas:${canvasId}`).emit('canvas_updated', {
      canvasId, kind: saved.canvas.kind, title: saved.canvas.title, content: saved.canvas.content,
      revision: Number(saved.canvas.revision), updatedAt: saved.canvas.updated_at,
    });
    res.json({ canvas: mapCanvas(saved.canvas) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Canvas restore error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Channel grants and ownership (standalone canvases) ----------------------------------------

// GET /api/canvas/:id/channels - channels this canvas is shared with
router.get('/:canvasId/channels', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'viewer');
    if (canvas.kind !== 'standalone') return res.status(400).json({ error: 'Only standalone canvases are shared with channels' });
    const result = await query(
      `SELECT g.channel_id, c.name, g.role, g.created_at
       FROM canvas_channel_grants g JOIN channels c ON c.id = g.channel_id
       WHERE g.canvas_id = $1 ORDER BY c.name`,
      [canvasId]
    );
    res.json({
      channels: result.rows.map((r) => ({ channelId: r.channel_id, name: r.name, role: r.role, createdAt: r.created_at })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('List canvas channel grants error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/canvas/:id/channels/:channelId { role } - share with every member of a channel
router.put('/:canvasId/channels/:channelId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    const channelId = parseId(req.params.channelId);
    if (canvasId === null || channelId === null) return res.status(400).json({ error: 'Canvas and channel IDs must be valid numbers' });
    const role = req.body?.role === 'editor' ? 'editor' : req.body?.role === 'viewer' ? 'viewer' : null;
    if (!role) return res.status(400).json({ error: 'role must be viewer or editor' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    if (canvas.kind !== 'standalone') return res.status(400).json({ error: 'Only standalone canvases are shared with channels' });
    if (canvasOwnerId(canvas) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can share this canvas with a channel' });
    // You can only share with a channel you belong to.
    await ensureChannelMembership(query, req.user.userId, channelId);
    await query(
      `INSERT INTO canvas_channel_grants (canvas_id, channel_id, role, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (canvas_id, channel_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by`,
      [canvasId, channelId, role, req.user.userId]
    );
    res.json({ grant: { channelId, role } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Grant canvas to channel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/canvas/:id/channels/:channelId - stop sharing with a channel
router.delete('/:canvasId/channels/:channelId', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    const channelId = parseId(req.params.channelId);
    if (canvasId === null || channelId === null) return res.status(400).json({ error: 'Canvas and channel IDs must be valid numbers' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    if (canvas.kind !== 'standalone') return res.status(400).json({ error: 'Only standalone canvases are shared with channels' });
    if (canvasOwnerId(canvas) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can change channel sharing' });
    await query('DELETE FROM canvas_channel_grants WHERE canvas_id = $1 AND channel_id = $2', [canvasId, channelId]);
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Revoke canvas channel grant error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/canvas/:id/owner { username } - hand ownership to someone else (the previous owner stays
// on as an editor). Guests cannot own canvases.
router.post('/:canvasId/owner', authenticateToken, async (req, res) => {
  try {
    const canvasId = parseId(req.params.canvasId);
    if (canvasId === null) return res.status(400).json({ error: 'A valid canvas ID is required' });
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    if (!username) return res.status(400).json({ error: 'Username is required' });
    const canvas = await ensureCanvasAccess(query, req.user.userId, canvasId, 'editor');
    if (canvas.kind !== 'standalone') return res.status(400).json({ error: 'Only standalone canvases have a transferable owner' });
    if (canvasOwnerId(canvas) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can transfer ownership' });
    const target = await query('SELECT id, username, account_type FROM users WHERE LOWER(username) = $1', [username]);
    const user = target.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (Number(user.id) === Number(req.user.userId)) return res.status(400).json({ error: 'You already own this canvas' });
    if (user.account_type === 'guest') return res.status(400).json({ error: 'Guests cannot own canvases' });
    await query('UPDATE canvases SET owner_id = $1 WHERE id = $2', [user.id, canvasId]);
    await query('DELETE FROM canvas_collaborators WHERE canvas_id = $1 AND user_id = $2', [canvasId, user.id]);
    await query(
      `INSERT INTO canvas_collaborators (canvas_id, user_id, role, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (canvas_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [canvasId, req.user.userId, 'editor', req.user.userId]
    );
    res.json({ ownerId: Number(user.id), ownerUsername: user.username });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Transfer canvas ownership error:', err);
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
    if (canvasOwnerId(canvas) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can create share links' });
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
    if (canvasOwnerId(canvas) !== Number(req.user.userId)) return res.status(403).json({ error: 'Only the owner can revoke share links' });
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
       WHERE cs.token = $1 AND c.deleted_at IS NULL`,
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
    const saved = await saveCanvasChanges(share.canvas_id, title, content, baseRevision, req.user.userId);
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
