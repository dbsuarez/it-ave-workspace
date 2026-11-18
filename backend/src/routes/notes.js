const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const notes = require('../notes');
const { parseRemindAt } = require('./reminders');

// Personal notes, Keep style: colours, pins, archive, trash, checklists, labels, pictures and reminders.
// Every route works only on the signed-in person's own notes.
const router = express.Router();
router.use(authenticateToken);
router.use(express.json({ limit: '4mb' })); // a 2 MB picture is about 2.7 MB as base64

const parseId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

// Replaces a note's labels with `labelIds`, which must all be the owner's.
async function setLabels(userId, noteId, labelIds) {
  if (labelIds.length) {
    const own = (await query('SELECT id FROM note_labels WHERE user_id = $1 AND id = ANY($2::int[])', [userId, labelIds])).rows;
    if (own.length !== labelIds.length) throw notes.fail(400, 'Unknown label');
  }
  await query('DELETE FROM note_label_links WHERE note_id = $1', [noteId]);
  if (labelIds.length) await query('INSERT INTO note_label_links (note_id, label_id) SELECT $1, l FROM unnest($2::int[]) AS l', [noteId, labelIds]);
}

const one = async (userId, noteId) => (await notes.loadNotes(query, userId, noteId))[0] || null;

// All of the person's notes (archived and trashed ones too: the screen filters) and their labels.
router.get('/', async (req, res) => {
  try {
    await notes.purgeExpiredTrash(query, req.user.userId);
    res.json({ notes: await notes.loadNotes(query, req.user.userId), labels: await notes.loadLabels(query, req.user.userId) });
  } catch (err) { sendError(res, err, 'List notes error'); }
});

router.post('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const input = notes.cleanNoteInput(req.body);
    const have = (await query('SELECT COUNT(*)::int AS n FROM notes WHERE user_id = $1 AND deleted_at IS NULL', [userId])).rows[0].n;
    if (have >= notes.MAX_NOTES) throw notes.fail(400, `You can keep at most ${notes.MAX_NOTES} notes`);
    const place = notes.placement({ pinned: false, archived: false, trashed: false }, { pinned: input.pinned, archived: input.archived });
    const created = (await query(
      `INSERT INTO notes (user_id, title, content, kind, items, color, pinned, archived_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, CASE WHEN $8 THEN NOW() ELSE NULL END) RETURNING id`,
      [userId, input.title || '', input.content || '', input.kind || 'text', JSON.stringify(input.items || []), input.color || 'default', place.pinned, place.archived]
    )).rows[0];
    if (input.labelIds && input.labelIds.length) await setLabels(userId, created.id, input.labelIds);
    res.status(201).json({ note: await one(userId, created.id) });
  } catch (err) { sendError(res, err, 'Create note error'); }
});

// Throws away the person's trashed notes now.
router.post('/trash/empty', async (req, res) => {
  try {
    const removed = await query('DELETE FROM notes WHERE user_id = $1 AND deleted_at IS NOT NULL RETURNING id', [req.user.userId]);
    res.json({ removed: removed.rows.length });
  } catch (err) { sendError(res, err, 'Empty trash error'); }
});

// Changes only what is sent. Pin, archive and trash follow Keep (see notes.placement).
router.put('/:id', async (req, res) => {
  try {
    const userId = req.user.userId;
    const id = parseId(req.params.id);
    const current = id ? await one(userId, id) : null;
    if (!current) throw notes.fail(404, 'Note not found');
    const input = notes.cleanNoteInput(req.body);
    const place = notes.placement(current, input);
    await query(
      `UPDATE notes SET title = COALESCE($3, title), content = COALESCE($4, content), kind = COALESCE($5, kind),
              items = COALESCE($6::jsonb, items), color = COALESCE($7, color), pinned = $8,
              archived_at = CASE WHEN $9 THEN COALESCE(archived_at, NOW()) ELSE NULL END,
              deleted_at = CASE WHEN $10 THEN COALESCE(deleted_at, NOW()) ELSE NULL END,
              updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [id, userId, input.title ?? null, input.content ?? null, input.kind ?? null, input.items ? JSON.stringify(input.items) : null, input.color ?? null, place.pinned, place.archived, place.trashed]
    );
    if (input.labelIds) await setLabels(userId, id, input.labelIds);
    res.json({ note: await one(userId, id) });
  } catch (err) { sendError(res, err, 'Update note error'); }
});

// Deletes a note for good (the screen moves notes to the trash first).
router.delete('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const removed = id ? await query('DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.user.userId]) : { rows: [] };
    if (!removed.rows.length) throw notes.fail(404, 'Note not found');
    res.json({ removed: true });
  } catch (err) { sendError(res, err, 'Delete note error'); }
});

// ---- labels (the person's own) ----
const MAX_LABELS = 50;
const cleanLabelName = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw notes.fail(400, 'A label needs a name');
  if (value.trim().length > 30) throw notes.fail(400, 'A label name can have at most 30 characters');
  return value.trim();
};
const labelTaken = async (userId, name, exceptId = 0) => (await query('SELECT 1 FROM note_labels WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3', [userId, name, exceptId])).rows.length > 0;

router.post('/labels', async (req, res) => {
  try {
    const userId = req.user.userId;
    const name = cleanLabelName(req.body && req.body.name);
    if ((await query('SELECT COUNT(*)::int AS n FROM note_labels WHERE user_id = $1', [userId])).rows[0].n >= MAX_LABELS) throw notes.fail(400, `You can have at most ${MAX_LABELS} labels`);
    if (await labelTaken(userId, name)) throw notes.fail(409, 'You already have a label with that name');
    const row = (await query('INSERT INTO note_labels (user_id, name) VALUES ($1, $2) RETURNING id, name', [userId, name])).rows[0];
    res.status(201).json({ label: { id: row.id, name: row.name } });
  } catch (err) { sendError(res, err, 'Create label error'); }
});

router.put('/labels/:id', async (req, res) => {
  try {
    const userId = req.user.userId;
    const id = parseId(req.params.id);
    const own = id ? (await query('SELECT id FROM note_labels WHERE id = $1 AND user_id = $2', [id, userId])).rows[0] : null;
    if (!own) throw notes.fail(404, 'Label not found');
    const name = cleanLabelName(req.body && req.body.name);
    if (await labelTaken(userId, name, id)) throw notes.fail(409, 'You already have a label with that name');
    const row = (await query('UPDATE note_labels SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id, name', [id, userId, name])).rows[0];
    res.json({ label: { id: row.id, name: row.name } });
  } catch (err) { sendError(res, err, 'Rename label error'); }
});

router.delete('/labels/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const removed = id ? await query('DELETE FROM note_labels WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.user.userId]) : { rows: [] };
    if (!removed.rows.length) throw notes.fail(404, 'Label not found');
    res.json({ removed: true }); // the notes stay; their links to it go with it
  } catch (err) { sendError(res, err, 'Delete label error'); }
});

// ---- pictures on a note ----
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES_PER_NOTE = 10;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const ownNoteId = async (userId, rawId) => {
  const id = parseId(rawId);
  const row = id ? (await query('SELECT id FROM notes WHERE id = $1 AND user_id = $2', [id, userId])).rows[0] : null;
  if (!row) throw notes.fail(404, 'Note not found');
  return id;
};

router.post('/:id/images', async (req, res) => {
  try {
    const noteId = await ownNoteId(req.user.userId, req.params.id);
    const { mime, dataBase64 } = req.body || {};
    if (!IMAGE_TYPES.has(mime)) throw notes.fail(400, 'Pictures can be PNG, JPEG, GIF or WebP');
    if (typeof dataBase64 !== 'string' || !dataBase64 || dataBase64.length % 4 !== 0 || !BASE64.test(dataBase64)) throw notes.fail(400, 'The picture data is not valid');
    if (dataBase64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw notes.fail(400, 'A picture can be at most 2 MB');
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw notes.fail(400, 'A picture can be at most 2 MB');
    if ((await query('SELECT COUNT(*)::int AS n FROM note_images WHERE note_id = $1', [noteId])).rows[0].n >= MAX_IMAGES_PER_NOTE) throw notes.fail(400, `A note can have at most ${MAX_IMAGES_PER_NOTE} pictures`);
    const row = (await query('INSERT INTO note_images (note_id, mime, bytes) VALUES ($1, $2, $3) RETURNING id, mime', [noteId, mime, bytes])).rows[0];
    await query('UPDATE notes SET updated_at = NOW() WHERE id = $1', [noteId]);
    res.status(201).json({ image: { id: row.id, mime: row.mime } });
  } catch (err) { sendError(res, err, 'Add note picture error'); }
});

router.get('/:id/images/:imageId', async (req, res) => {
  try {
    const noteId = await ownNoteId(req.user.userId, req.params.id);
    const imageId = parseId(req.params.imageId);
    const row = imageId ? (await query('SELECT mime, bytes FROM note_images WHERE id = $1 AND note_id = $2', [imageId, noteId])).rows[0] : null;
    if (!row) throw notes.fail(404, 'Picture not found');
    res.set({ 'Content-Type': row.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(row.bytes);
  } catch (err) { sendError(res, err, 'Get note picture error'); }
});

router.delete('/:id/images/:imageId', async (req, res) => {
  try {
    const noteId = await ownNoteId(req.user.userId, req.params.id);
    const imageId = parseId(req.params.imageId);
    const removed = imageId ? await query('DELETE FROM note_images WHERE id = $1 AND note_id = $2 RETURNING id', [imageId, noteId]) : { rows: [] };
    if (!removed.rows.length) throw notes.fail(404, 'Picture not found');
    res.json({ removed: true });
  } catch (err) { sendError(res, err, 'Delete note picture error'); }
});

// ---- a reminder on a note: an ordinary reminder (so the pop-up and the Later list work), linked to the note ----
router.put('/:id/reminder', async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = await ownNoteId(userId, req.params.id);
    const remindAt = parseRemindAt(req.body && req.body.remindAt);
    await query('DELETE FROM reminders WHERE note_id = $1 AND user_id = $2 AND delivered_at IS NULL', [noteId, userId]);
    if ((await query('SELECT COUNT(*)::int AS n FROM reminders WHERE user_id = $1 AND delivered_at IS NULL', [userId])).rows[0].n >= 100) throw notes.fail(400, 'You have too many pending reminders');
    const title = (await query('SELECT title FROM notes WHERE id = $1', [noteId])).rows[0].title;
    await query('INSERT INTO reminders (user_id, text, note_id, remind_at) VALUES ($1, $2, $3, $4)', [userId, (title || 'Note').slice(0, 500), noteId, remindAt]);
    res.json({ note: await one(userId, noteId) });
  } catch (err) { sendError(res, err, 'Set note reminder error'); }
});

router.delete('/:id/reminder', async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = await ownNoteId(userId, req.params.id);
    await query('DELETE FROM reminders WHERE note_id = $1 AND user_id = $2 AND delivered_at IS NULL', [noteId, userId]);
    res.json({ note: await one(userId, noteId) });
  } catch (err) { sendError(res, err, 'Clear note reminder error'); }
});

module.exports = router;
