// Drawings: who may open and edit a drawing, checked fresh every time.
//
// A channel (or forum-topic) drawing follows channel access exactly, through the same check messages use, so bans, department
// membership and the Owner private-channel switch all apply. A standalone drawing follows its owner and the people invited.
// A guest account never edits. Where a drawing lives being archived, or its topic being locked or archived, makes it view-only.
const { ensureChannelMembership } = require('./security');

const fail = (status, message) => Object.assign(new Error(message), { status });

// The drawing row without its (large) scene.
async function loadDrawing(query, id) {
  const found = await query(
    `SELECT id, title, owner_id, channel_id, topic_id, message_id, revision, created_at, updated_at, updated_by
     FROM drawings WHERE id = $1`,
    [id]
  );
  if (!found.rows.length) throw fail(404, 'Drawing not found');
  return found.rows[0];
}

const NO_ACCESS = Object.freeze({ role: null, readOnlyReason: null });

// -> { role: 'editor' | 'viewer' | null, readOnlyReason: 'archived' | 'locked' | null }
async function drawingAccess(query, userId, drawing) {
  const person = (await query('SELECT account_type, deactivated_at FROM users WHERE id = $1', [userId])).rows[0];
  if (!person || person.deactivated_at) return NO_ACCESS;
  const guest = person.account_type === 'guest';

  let role = null;
  let readOnlyReason = null;
  if (drawing.channel_id) {
    try {
      await ensureChannelMembership(query, userId, drawing.channel_id);
    } catch (err) {
      if (err.status === 403 || err.status === 404) return NO_ACCESS;
      throw err;
    }
    role = 'editor';
    const place = (await query(
      `SELECT c.archived_at AS channel_archived, t.locked_at, t.archived_at AS topic_archived
       FROM channels c LEFT JOIN forum_topics t ON t.id = $2 WHERE c.id = $1`,
      [drawing.channel_id, drawing.topic_id || null]
    )).rows[0];
    if (place && (place.channel_archived || place.topic_archived)) readOnlyReason = 'archived';
    else if (place && place.locked_at) readOnlyReason = 'locked';
  } else if (Number(drawing.owner_id) === Number(userId)) {
    role = 'editor';
  } else {
    const member = (await query('SELECT role FROM drawing_members WHERE drawing_id = $1 AND user_id = $2', [drawing.id, userId])).rows[0];
    role = member ? member.role : null;
  }
  if (!role) return NO_ACCESS;
  if (guest || readOnlyReason) role = 'viewer';
  return { role, readOnlyReason };
}

async function drawingRole(query, userId, drawing) {
  return (await drawingAccess(query, userId, drawing)).role;
}

// Loads the drawing and checks the person may do `need` ('viewer' to read, 'editor' to change).
// -> { drawing, role, readOnlyReason }; throws 404 (no such drawing), 403 (no access, or only a viewer), or 409 (view-only because of where it lives).
async function requireDrawingRole(query, userId, id, need = 'viewer') {
  const drawing = await loadDrawing(query, id);
  const { role, readOnlyReason } = await drawingAccess(query, userId, drawing);
  if (!role) throw fail(403, 'Access denied');
  if (need === 'editor' && role !== 'editor') {
    if (readOnlyReason) throw fail(409, readOnlyReason === 'locked' ? 'This topic is locked, so the drawing is view-only' : 'This drawing is archived, so it is view-only');
    throw fail(403, 'You can only view this drawing');
  }
  return { drawing, role, readOnlyReason };
}

module.exports = { loadDrawing, drawingAccess, drawingRole, requireDrawingRole };
