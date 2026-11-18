// Notes, Keep style (see docs/superpowers/specs/2026-11-18-notes-keep-design.md). Validation of what a person sends, the shape
// sent back, and the trash rule. Everything is about one owner's notes: every query here is scoped to a user id.
const crypto = require('crypto');

const COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'darkblue', 'purple', 'pink', 'brown', 'gray'];
const KINDS = ['text', 'checklist'];
const MAX_NOTES = 1000;
const MAX_TITLE = 200;
const MAX_CONTENT = 100000;
const MAX_ITEMS = 200;
const MAX_ITEM_TEXT = 500;
const TRASH_DAYS = 30;

const fail = (status, message) => Object.assign(new Error(message), { status });

function cleanItems(value) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw fail(400, `A checklist can have at most ${MAX_ITEMS} items`);
  return value.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string') throw fail(400, 'Every checklist item needs text');
    if (item.text.length > MAX_ITEM_TEXT) throw fail(400, `A checklist item can have at most ${MAX_ITEM_TEXT} characters`);
    const id = typeof item.id === 'string' && item.id ? item.id.slice(0, 40) : crypto.randomBytes(6).toString('hex');
    return { id, text: item.text, done: Boolean(item.done) };
  });
}

// What a request may set: only the keys that are present are returned, each checked.
function cleanNoteInput(body) {
  const input = body && typeof body === 'object' ? body : {};
  const out = {};
  if (input.title !== undefined) {
    if (typeof input.title !== 'string') throw fail(400, 'The title must be text');
    out.title = input.title.trim().slice(0, MAX_TITLE);
  }
  if (input.content !== undefined) {
    if (typeof input.content !== 'string') throw fail(400, 'The note must be text');
    if (input.content.length > MAX_CONTENT) throw fail(400, `A note can have at most ${MAX_CONTENT} characters`);
    out.content = input.content;
  }
  if (input.kind !== undefined) {
    if (!KINDS.includes(input.kind)) throw fail(400, 'A note is a text note or a checklist');
    out.kind = input.kind;
  }
  if (input.items !== undefined) out.items = cleanItems(input.items);
  if (input.color !== undefined) {
    if (!COLORS.includes(input.color)) throw fail(400, 'Unknown colour');
    out.color = input.color;
  }
  for (const flag of ['pinned', 'archived', 'trashed']) {
    if (input[flag] !== undefined) {
      if (typeof input[flag] !== 'boolean') throw fail(400, `${flag} must be true or false`);
      out[flag] = input[flag];
    }
  }
  if (input.labelIds !== undefined) {
    if (!Array.isArray(input.labelIds) || input.labelIds.length > 50 || input.labelIds.some((id) => !Number.isInteger(id) || id < 1)) throw fail(400, 'labelIds must be a list of label ids');
    out.labelIds = [...new Set(input.labelIds)];
  }
  return out;
}

// Pin, archive and trash follow Keep: archiving or trashing unpins; pinning brings a note back from the archive.
function placement(current, change) {
  let pinned = change.pinned !== undefined ? change.pinned : current.pinned;
  let archived = change.archived !== undefined ? change.archived : current.archived;
  const trashed = change.trashed !== undefined ? change.trashed : current.trashed;
  if (change.pinned === true && change.archived === undefined) archived = false;
  if (archived || trashed) pinned = false;
  if (trashed) archived = false;
  return { pinned, archived, trashed };
}

// The person's notes (or one of them) in the shape the client uses.
async function loadNotes(query, userId, noteId = null) {
  const only = noteId === null ? '' : ' AND n.id = $2';
  const args = noteId === null ? [userId] : [userId, noteId];
  const notes = (await query(
    `SELECT n.id, n.title, n.content, n.kind, n.items, n.color, n.pinned, n.archived_at, n.deleted_at, n.created_at, n.updated_at
     FROM notes n WHERE n.user_id = $1${only} ORDER BY n.updated_at DESC, n.id DESC`, args)).rows;
  const links = (await query(`SELECT l.note_id, l.label_id FROM note_label_links l JOIN notes n ON n.id = l.note_id WHERE n.user_id = $1${only} ORDER BY l.label_id`, args)).rows;
  const images = (await query(`SELECT i.id, i.note_id, i.mime FROM note_images i JOIN notes n ON n.id = i.note_id WHERE n.user_id = $1${only} ORDER BY i.id`, args)).rows;
  const reminders = (await query(
    `SELECT r.id, r.note_id, r.remind_at FROM reminders r JOIN notes n ON n.id = r.note_id
     WHERE r.user_id = $1 AND r.delivered_at IS NULL${only} ORDER BY r.remind_at`, args)).rows;
  return notes.map((row) => {
    const reminder = reminders.find((r) => r.note_id === row.id);
    return {
      id: row.id, title: row.title, content: row.content, kind: row.kind, items: row.items || [], color: row.color,
      pinned: row.pinned, archived: Boolean(row.archived_at), trashed: Boolean(row.deleted_at),
      trashedAt: row.deleted_at, createdAt: row.created_at, updatedAt: row.updated_at,
      labelIds: links.filter((l) => l.note_id === row.id).map((l) => l.label_id),
      images: images.filter((i) => i.note_id === row.id).map((i) => ({ id: i.id, mime: i.mime })),
      reminder: reminder ? { id: reminder.id, remindAt: reminder.remind_at } : null,
    };
  });
}

async function loadLabels(query, userId) {
  return (await query('SELECT id, name FROM note_labels WHERE user_id = $1 ORDER BY LOWER(name)', [userId])).rows.map((row) => ({ id: row.id, name: row.name }));
}

// Notes left in the trash for more than TRASH_DAYS days go for good. One person, or everyone when no id is given.
async function purgeExpiredTrash(query, userId = null) {
  const result = await query(
    'DELETE FROM notes WHERE deleted_at < NOW() - make_interval(days => $1) AND ($2::int IS NULL OR user_id = $2) RETURNING id', [TRASH_DAYS, userId]);
  return result.rows.length;
}

module.exports = { COLORS, KINDS, MAX_NOTES, TRASH_DAYS, fail, cleanNoteInput, placement, loadNotes, loadLabels, purgeExpiredTrash };
