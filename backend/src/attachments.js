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

async function insertChannelMessage(query, { channelId, userId, content, replyTo, attachmentId }) {
  if (!attachmentId) {
    const plain = await query(
      `INSERT INTO messages (channel_id, user_id, content, reply_to)
       VALUES ($1, $2, $3, $4)
       RETURNING id, channel_id, user_id, content, reply_to, created_at`,
      [channelId, userId, content || '', replyTo || null]
    );
    return plain.rows[0];
  }

  const result = await query(
    `WITH claim AS (
       SELECT id FROM files
       WHERE id = $5 AND uploaded_by = $2 AND message_id IS NULL AND dm_message_id IS NULL
       FOR UPDATE
     ), msg AS (
       INSERT INTO messages (channel_id, user_id, content, reply_to)
       SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM claim)
       RETURNING id, channel_id, user_id, content, reply_to, created_at
     ), linked AS (
       UPDATE files SET message_id = (SELECT id FROM msg)
       WHERE id IN (SELECT id FROM claim) AND EXISTS (SELECT 1 FROM msg)
       RETURNING id
     )
     SELECT msg.* FROM msg`,
    [channelId, userId, content || '', replyTo || null, attachmentId]
  );
  return result.rows[0] || null;
}

async function insertDirectMessage(query, { senderId, receiverId, content, attachmentId }) {
  if (!attachmentId) {
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
       WHERE id = $4 AND uploaded_by = $1 AND message_id IS NULL AND dm_message_id IS NULL
       FOR UPDATE
     ), dm AS (
       INSERT INTO direct_messages (sender_id, receiver_id, content)
       SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM claim)
       RETURNING id, sender_id, receiver_id, content, created_at
     ), linked AS (
       UPDATE files SET dm_message_id = (SELECT id FROM dm)
       WHERE id IN (SELECT id FROM claim) AND EXISTS (SELECT 1 FROM dm)
       RETURNING id
     )
     SELECT dm.* FROM dm`,
    [senderId, receiverId, content || '', attachmentId]
  );
  return result.rows[0] || null;
}

function parseAttachmentId(value) {
  if (value === undefined || value === null || value === '') return { ok: true, id: null };
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? { ok: true, id } : { ok: false, id: null };
}

const ATTACHMENT_UNAVAILABLE = 'Attachment not found, not yours, or already used';

module.exports = {
  insertChannelMessage,
  insertDirectMessage,
  parseAttachmentId,
  ATTACHMENT_UNAVAILABLE,
};
