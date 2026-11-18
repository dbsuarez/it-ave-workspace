const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const notes = require('../notes');

// Personal notes, Keep style: colours, pins, archive, trash, checklists, labels, pictures and reminders.
// Every route works only on the signed-in person's own notes.
const router = express.Router();
router.use(authenticateToken);

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

module.exports = router;
