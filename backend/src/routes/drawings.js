// Drawings (Excalidraw): list, create, read, rename, invite, share a copy, delete, and the images stored with a drawing.
// Every request re-checks access (drawingAccess.js). Live editing happens over Socket.IO (sockets/drawings.js).
const express = require('express');
const { query, pool } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership } = require('../security');
const { requireDrawingRole } = require('../drawingAccess');
const drawings = require('../drawings');
const { MAX_DRAWING_FILE_BYTES } = require('../drawingMerge');

const router = express.Router();
router.use(authenticateToken);
router.use(express.json({ limit: '16mb' })); // a drawing or a picture can be several megabytes

const fail = (status, message) => Object.assign(new Error(message), { status });
const parseId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);
const needId = (value, what = 'drawing') => { const id = parseId(value); if (!id) throw fail(400, `A valid ${what} is required`); return id; };
function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}
const context = (req) => ({ io: req.io, pool, query });

const LIST_SQL = `SELECT d.id, d.title, d.owner_id, d.channel_id, d.topic_id, d.message_id, d.revision, d.created_at, d.updated_at, u.username AS owner_username`;

// GET /api/drawings?scope=mine|shared  or  ?channelId=<id>[&topicId=<id>]
router.get('/', async (req, res) => {
  try {
    const me = req.user.userId;
    const guest = (await query('SELECT account_type FROM users WHERE id = $1', [me])).rows[0]?.account_type === 'guest';
    const editor = guest ? 'viewer' : 'editor';
    if (req.query.channelId !== undefined) {
      const channelId = needId(req.query.channelId, 'channel');
      await ensureChannelMembership(query, me, channelId);
      const topicFilter = req.query.topicId === undefined ? null : needId(req.query.topicId, 'topic');
      const rows = (await query(
        `${LIST_SQL}, c.archived_at AS channel_archived, t.locked_at, t.archived_at AS topic_archived
         FROM drawings d JOIN users u ON u.id = d.owner_id JOIN channels c ON c.id = d.channel_id
         LEFT JOIN forum_topics t ON t.id = d.topic_id
         WHERE d.channel_id = $1 AND ($2::int IS NULL OR d.topic_id = $2) ORDER BY d.updated_at DESC, d.id DESC`,
        [channelId, topicFilter]
      )).rows;
      return res.json({
        drawings: rows.map((row) => {
          const readOnlyReason = row.channel_archived || row.topic_archived ? 'archived' : (row.locked_at ? 'locked' : null);
          return drawings.serializeDrawing(row, { role: readOnlyReason ? 'viewer' : editor, readOnlyReason });
        }),
      });
    }
    if (req.query.scope === 'mine') {
      const rows = (await query(`${LIST_SQL} FROM drawings d JOIN users u ON u.id = d.owner_id WHERE d.channel_id IS NULL AND d.owner_id = $1 ORDER BY d.updated_at DESC, d.id DESC`, [me])).rows;
      return res.json({ drawings: rows.map((row) => drawings.serializeDrawing(row, { role: editor })) });
    }
    if (req.query.scope === 'shared') {
      const rows = (await query(
        `${LIST_SQL}, m.role AS member_role FROM drawings d JOIN users u ON u.id = d.owner_id JOIN drawing_members m ON m.drawing_id = d.id
         WHERE d.channel_id IS NULL AND m.user_id = $1 ORDER BY d.updated_at DESC, d.id DESC`,
        [me]
      )).rows;
      return res.json({ drawings: rows.map((row) => drawings.serializeDrawing(row, { role: guest ? 'viewer' : row.member_role })) });
    }
    throw fail(400, 'Ask for scope=mine, scope=shared or a channelId');
  } catch (err) { sendError(res, err, 'List drawings error'); }
});

// POST /api/drawings { title, channelId?, topicId?, scene?, files? }
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const title = drawings.cleanTitle(body.title);
    const scene = drawings.validateScene(body.scene === undefined ? { elements: [] } : body.scene);
    const images = drawings.decodeImages(body.files);
    const channelId = body.channelId === undefined || body.channelId === null ? null : needId(body.channelId, 'channel');
    const topicId = body.topicId === undefined || body.topicId === null ? null : needId(body.topicId, 'topic');
    res.status(201).json(await drawings.createDrawing(context(req), { userId: req.user.userId, title, channelId, topicId, scene, images }));
  } catch (err) { sendError(res, err, 'Create drawing error'); }
});

// GET /api/drawings/:id -> the drawing with its scene, the list of its pictures, my role, and (for the owner of a standalone drawing) who it is shared with
router.get('/:id', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { drawing, role, readOnlyReason } = await requireDrawingRole(query, req.user.userId, id, 'viewer');
    const full = (await query('SELECT scene, revision FROM drawings WHERE id = $1', [id])).rows[0];
    const files = (await query('SELECT file_key, mime FROM drawing_files WHERE drawing_id = $1 ORDER BY file_key', [id])).rows;
    const owner = (await query('SELECT username FROM users WHERE id = $1', [drawing.owner_id])).rows[0];
    const body = {
      drawing: drawings.serializeDrawing({ ...drawing, revision: full.revision }, { role, readOnlyReason, ownerUsername: owner?.username }),
      scene: full.scene,
      files: files.map((file) => ({ key: file.file_key, mime: file.mime })),
      role, readOnlyReason,
    };
    if (!drawing.channel_id && Number(drawing.owner_id) === Number(req.user.userId)) {
      body.members = (await query(
        'SELECT m.user_id, u.username, m.role FROM drawing_members m JOIN users u ON u.id = m.user_id WHERE m.drawing_id = $1 ORDER BY u.username', [id]
      )).rows.map((row) => ({ userId: row.user_id, username: row.username, role: row.role }));
    }
    res.json(body);
  } catch (err) { sendError(res, err, 'Get drawing error'); }
});

// PATCH /api/drawings/:id { title }
router.patch('/:id', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { drawing } = await requireDrawingRole(query, req.user.userId, id, 'editor');
    const title = drawings.cleanTitle(req.body?.title);
    await query('UPDATE drawings SET title = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3', [title, req.user.userId, id]);
    if (drawing.message_id) {
      await query('UPDATE messages SET content = $1 WHERE id = $2', [title, drawing.message_id]);
      req.io?.to(`channel_${drawing.channel_id}`).emit('message_updated', { messageId: drawing.message_id, channelId: drawing.channel_id, topicId: drawing.topic_id, content: title, drawing: { id, title } });
    }
    res.json({ drawing: drawings.serializeDrawing({ ...drawing, title }, { role: 'editor' }) });
  } catch (err) { sendError(res, err, 'Rename drawing error'); }
});

// DELETE /api/drawings/:id (its owner, or a channel or forum moderator)
router.delete('/:id', async (req, res) => {
  try {
    const id = needId(req.params.id);
    const { drawing } = await requireDrawingRole(query, req.user.userId, id, 'viewer');
    if (!(await drawings.mayDeleteDrawing(query, req.user.userId, drawing))) throw fail(403, 'Only its owner or a moderator can delete a drawing');
    await drawings.deleteDrawing({ io: req.io, query }, { drawing, actorId: req.user.userId });
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Delete drawing error'); }
});

// Invitations (standalone drawings, owner only)
async function ownedStandalone(req) {
  const id = needId(req.params.id);
  const { drawing } = await requireDrawingRole(query, req.user.userId, id, 'viewer');
  if (drawing.channel_id) throw fail(400, 'A channel drawing is shared with its channel; invitations are for standalone drawings');
  if (Number(drawing.owner_id) !== Number(req.user.userId)) throw fail(403, 'Only the owner can change who a drawing is shared with');
  return drawing;
}

router.put('/:id/members/:userId', async (req, res) => {
  try {
    const drawing = await ownedStandalone(req);
    const userId = needId(req.params.userId, 'person');
    const role = req.body?.role;
    if (role !== 'editor' && role !== 'viewer') throw fail(400, 'The role must be editor or viewer');
    if (userId === Number(drawing.owner_id)) throw fail(400, 'The owner already has full access');
    const person = (await query('SELECT id FROM users WHERE id = $1 AND deactivated_at IS NULL', [userId])).rows[0];
    if (!person) throw fail(404, 'Person not found');
    await query(
      `INSERT INTO drawing_members (drawing_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (drawing_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [drawing.id, userId, role]
    );
    res.json({ userId, role });
  } catch (err) { sendError(res, err, 'Invite to drawing error'); }
});

router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const drawing = await ownedStandalone(req);
    const removed = await query('DELETE FROM drawing_members WHERE drawing_id = $1 AND user_id = $2 RETURNING user_id', [drawing.id, needId(req.params.userId, 'person')]);
    if (!removed.rows.length) throw fail(404, 'That person was not invited');
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Remove from drawing error'); }
});

// POST /api/drawings/:id/share { channelId, topicId? } -> a copy in that channel or topic, with its card
router.post('/:id/share', async (req, res) => {
  try {
    const id = needId(req.params.id);
    await requireDrawingRole(query, req.user.userId, id, 'viewer');
    const channelId = needId(req.body?.channelId, 'channel');
    const topicId = req.body?.topicId === undefined || req.body.topicId === null ? null : needId(req.body.topicId, 'topic');
    res.status(201).json(await drawings.copyDrawing(context(req), { userId: req.user.userId, sourceId: id, channelId, topicId }));
  } catch (err) { sendError(res, err, 'Share drawing error'); }
});

// Pictures inserted into a drawing
router.post('/:id/files', async (req, res) => {
  try {
    const id = needId(req.params.id);
    await requireDrawingRole(query, req.user.userId, id, 'editor');
    const image = drawings.decodeImage(req.body);
    const used = (await query('SELECT COALESCE(SUM(octet_length(bytes)), 0)::bigint AS n FROM drawing_files WHERE drawing_id = $1 AND file_key <> $2', [id, image.key])).rows[0].n;
    if (Number(used) + image.bytes.length > MAX_DRAWING_FILE_BYTES) throw fail(400, 'A drawing can hold at most 20 MB of pictures');
    await query(
      `INSERT INTO drawing_files (drawing_id, file_key, mime, bytes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (drawing_id, file_key) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes`,
      [id, image.key, image.mime, image.bytes]
    );
    res.status(201).json({ file: { key: image.key, mime: image.mime } });
  } catch (err) { sendError(res, err, 'Upload drawing image error'); }
});

router.get('/:id/files/:key', async (req, res) => {
  try {
    const id = needId(req.params.id);
    await requireDrawingRole(query, req.user.userId, id, 'viewer');
    const file = (await query('SELECT mime, bytes FROM drawing_files WHERE drawing_id = $1 AND file_key = $2', [id, req.params.key])).rows[0];
    if (!file) throw fail(404, 'Picture not found');
    res.set({
      'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", // an SVG opened directly may not run anything
    });
    res.send(file.bytes);
  } catch (err) { sendError(res, err, 'Get drawing image error'); }
});

module.exports = router;
