// Creating a message that carries an uploaded file.
//
// The upload is claimed and the message created in ONE statement, so:
//  - a file can be attached to exactly one message (channel or direct), once;
//  - two sends racing for the same file cannot both win (the loser matches no row
//    and creates no message);
//  - a message is never left behind when its attachment could not be claimed.
//
// `FOR UPDATE` makes a second concurrent statement wait for the first to finish
// and then re-check the "not yet attached" condition against the new row.

const MAX_ATTACHMENTS = 10;

// attachmentIds (a list) or the older single attachmentId -> a de-duplicated list of ids.
function idList({ attachmentIds, attachmentId }) {
  const raw = Array.isArray(attachmentIds) ? attachmentIds : [];
  if (attachmentId !== undefined && attachmentId !== null && attachmentId !== '') raw.push(attachmentId);
  return Array.from(new Set(raw.map(Number)));
}

async function insertChannelMessage(query, { channelId, userId, content, replyTo, attachmentId, attachmentIds }) {
  const ids = idList({ attachmentIds, attachmentId });
  if (!ids.length) {
    const plain = await query(
      `INSERT INTO messages (channel_id, user_id, content, reply_to)
       VALUES ($1, $2, $3, $4)
       RETURNING id, channel_id, user_id, content, reply_to, created_at`,
      [channelId, userId, content || '', replyTo || null]
    );
    return plain.rows[0];
  }

  // every file must be claimable (yours, not attached yet), or no message is created at all
  const result = await query(
    `WITH claim AS (
       SELECT id FROM files
       WHERE id = ANY($5::int[]) AND uploaded_by = $2 AND message_id IS NULL AND dm_message_id IS NULL
       FOR UPDATE
     ), msg AS (
       INSERT INTO messages (channel_id, user_id, content, reply_to)
       SELECT $1, $2, $3, $4 WHERE (SELECT COUNT(*) FROM claim) = $6
       RETURNING id, channel_id, user_id, content, reply_to, created_at
     ), linked AS (
       UPDATE files SET message_id = (SELECT id FROM msg)
       WHERE id IN (SELECT id FROM claim) AND EXISTS (SELECT 1 FROM msg)
       RETURNING id
     )
     SELECT msg.* FROM msg`,
    [channelId, userId, content || '', replyTo || null, ids, ids.length]
  );
  return result.rows[0] || null;
}

async function insertDirectMessage(query, { senderId, receiverId, content, attachmentId, attachmentIds }) {
  const ids = idList({ attachmentIds, attachmentId });
  if (!ids.length) {
    const plain = await query(
      `INSERT INTO direct_messages (sender_id, receiver_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, sender_id, receiver_id, content, created_at`,
      [senderId, receiverId, content || '']
    );
    return plain.rows[0];
  }

  const result = await query(
    `WITH claim AS (
       SELECT id FROM files
       WHERE id = ANY($4::int[]) AND uploaded_by = $1 AND message_id IS NULL AND dm_message_id IS NULL
       FOR UPDATE
     ), dm AS (
       INSERT INTO direct_messages (sender_id, receiver_id, content)
       SELECT $1, $2, $3 WHERE (SELECT COUNT(*) FROM claim) = $5
       RETURNING id, sender_id, receiver_id, content, created_at
     ), linked AS (
       UPDATE files SET dm_message_id = (SELECT id FROM dm)
       WHERE id IN (SELECT id FROM claim) AND EXISTS (SELECT 1 FROM dm)
       RETURNING id
     )
     SELECT dm.* FROM dm`,
    [senderId, receiverId, content || '', ids, ids.length]
  );
  return result.rows[0] || null;
}

function parseAttachmentId(value) {
  if (value === undefined || value === null || value === '') return { ok: true, id: null };
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? { ok: true, id } : { ok: false, id: null };
}

// What a socket message names as attachments: { ok, ids }. ok is false for anything that is not a list of up to 10 real ids.
function parseAttachmentIds(data) {
  const list = Array.isArray(data.attachmentIds) ? data.attachmentIds : [];
  if (list.length > MAX_ATTACHMENTS) return { ok: false, ids: [] };
  const single = parseAttachmentId(data.attachmentId);
  if (!single.ok) return { ok: false, ids: [] };
  const ids = [];
  for (const raw of list) {
    const parsed = parseAttachmentId(raw);
    if (!parsed.ok || parsed.id === null) return { ok: false, ids: [] };
    ids.push(parsed.id);
  }
  if (single.id !== null) ids.push(single.id);
  const unique = Array.from(new Set(ids));
  return unique.length > MAX_ATTACHMENTS ? { ok: false, ids: [] } : { ok: true, ids: unique };
}

const ATTACHMENT_UNAVAILABLE = 'Attachment not found, not yours, or already used';

module.exports = {
  insertChannelMessage,
  insertDirectMessage,
  parseAttachmentId,
  parseAttachmentIds,
  MAX_ATTACHMENTS,
  ATTACHMENT_UNAVAILABLE,
};
