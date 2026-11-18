// Drawings: creating, copying and deleting them, their conversation cards, and the images stored with them.
// The routes (routes/drawings.js) call these; access rules live in drawingAccess.js, the shape rules in drawingMerge.js.
const { ensureCanPostToChannel, ensureChannelModerator } = require('./security');
const { ensureTopicOpen } = require('./forums');
const { broadcastChannelMessage, loadSender } = require('./messageDelivery');
const { validateScene, MAX_IMAGE_BYTES, MAX_DRAWING_FILE_BYTES } = require('./drawingMerge');

const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_TITLE = 120;
const MAX_FILES_PER_REQUEST = 200;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/avif', 'image/x-icon']);
const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function cleanTitle(value) {
  if (typeof value !== 'string') throw fail(400, 'A drawing needs a title');
  const title = value.trim();
  if (!title) throw fail(400, 'A drawing needs a title');
  if (title.length > MAX_TITLE) throw fail(400, `A title can be at most ${MAX_TITLE} characters`);
  return title;
}

// One image from a request: { key, mime, dataBase64 } -> { key, mime, bytes: Buffer }; throws 400.
function decodeImage(file) {
  if (!file || typeof file !== 'object') throw fail(400, 'Every image needs a key, a type and its data');
  if (typeof file.key !== 'string' || !KEY_PATTERN.test(file.key)) throw fail(400, 'An image key is 1 to 64 letters, numbers, dots, dashes or underscores');
  if (!IMAGE_TYPES.has(file.mime)) throw fail(400, 'That is not a picture type we store');
  if (typeof file.dataBase64 !== 'string' || file.dataBase64.length % 4 !== 0 || !BASE64_PATTERN.test(file.dataBase64)) throw fail(400, 'The image data is not valid');
  if (file.dataBase64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw fail(400, 'A picture can be at most 2 MB');
  const bytes = Buffer.from(file.dataBase64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw fail(400, 'A picture can be at most 2 MB');
  return { key: file.key, mime: file.mime, bytes };
}

const MAX_PREVIEW_BYTES = 300 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The card preview from a request: { dataBase64 } -> Buffer of a PNG, at most 300 KB; throws 400.
function decodePreview(body) {
  const data = body && body.dataBase64;
  if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) throw fail(400, 'The preview data is not valid');
  if (data.length > Math.ceil((MAX_PREVIEW_BYTES * 4) / 3) + 8) throw fail(400, 'A preview can be at most 300 KB');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_PREVIEW_BYTES) throw fail(400, 'A preview can be at most 300 KB');
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw fail(400, 'A preview must be a PNG picture');
  return bytes;
}

const previewVersionOf = (row) => (row.preview_at ? new Date(row.preview_at).getTime() : null);

function decodeImages(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > MAX_FILES_PER_REQUEST) throw fail(400, 'files must be a list of pictures');
  const images = files.map(decodeImage);
  if (new Set(images.map((image) => image.key)).size !== images.length) throw fail(400, 'Every image key must be different');
  if (images.reduce((sum, image) => sum + image.bytes.length, 0) > MAX_DRAWING_FILE_BYTES) throw fail(400, 'A drawing can hold at most 20 MB of pictures');
  return images;
}

const kindOf = (row) => (row.channel_id ? (row.topic_id ? 'topic' : 'channel') : 'standalone');

function serializeDrawing(row, { role = null, readOnlyReason = null, ownerUsername } = {}) {
  return {
    id: Number(row.id), title: row.title, kind: kindOf(row), ownerId: row.owner_id, ownerUsername: ownerUsername || row.owner_username || null,
    channelId: row.channel_id, topicId: row.topic_id, messageId: row.message_id, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, role, readOnlyReason, previewVersion: previewVersionOf(row),
  };
}

// The cards of drawings, for message history: Map(messageId -> { id, title, previewVersion }). A removed drawing has no entry.
async function drawingsForMessages(query, messageIds) {
  const byMessage = new Map();
  if (!messageIds.length) return byMessage;
  const rows = (await query('SELECT id, title, message_id, preview_at FROM drawings WHERE message_id = ANY($1::int[])', [messageIds])).rows;
  for (const row of rows) byMessage.set(row.message_id, { id: Number(row.id), title: row.title, previewVersion: previewVersionOf(row) });
  return byMessage;
}

// Creates a drawing: standalone (no channelId), or in a channel / forum topic, where it also posts its card.
// `scene` and `images` are already validated. Everything is written in one transaction, so a refusal leaves nothing behind.
async function createDrawing({ io, pool, query }, { userId, title, channelId = null, topicId = null, scene, images = [] }) {
  const person = (await query('SELECT account_type, username FROM users WHERE id = $1', [userId])).rows[0];
  if (!person) throw fail(404, 'User not found');
  if (person.account_type === 'guest') throw fail(403, 'Guests can view drawings but not create them');
  let topic = null;
  if (channelId !== null) {
    await ensureCanPostToChannel(query, userId, channelId);
    topic = await ensureTopicOpen(query, channelId, topicId, { forPosting: true });
  } else if (topicId !== null) {
    throw fail(400, 'A topic belongs to a forum: say which one');
  }

  const client = await pool.connect();
  let drawing; let message = null;
  try {
    await client.query('BEGIN');
    if (topic) {
      const row = (await client.query('SELECT locked_at, archived_at FROM forum_topics WHERE id = $1 AND channel_id = $2 FOR UPDATE', [topic, channelId])).rows[0];
      if (!row) throw fail(404, 'Topic not found');
      if (row.locked_at || row.archived_at) throw fail(409, row.locked_at ? 'This topic is locked' : 'This topic is archived');
    }
    drawing = (await client.query(
      'INSERT INTO drawings (title, owner_id, channel_id, topic_id, scene, updated_by) VALUES ($1, $2, $3, $4, $5, $2) RETURNING *',
      [title, userId, channelId, topic, JSON.stringify(scene)]
    )).rows[0];
    for (const image of images) {
      await client.query('INSERT INTO drawing_files (drawing_id, file_key, mime, bytes) VALUES ($1, $2, $3, $4)', [drawing.id, image.key, image.mime, image.bytes]);
    }
    if (channelId !== null) {
      message = (await client.query(
        `INSERT INTO messages (channel_id, user_id, content, kind, topic_id) VALUES ($1, $2, $3, 'drawing', $4)
         RETURNING id, channel_id, user_id, content, reply_to, created_at, kind, topic_id`,
        [channelId, userId, title, topic]
      )).rows[0];
      await client.query('UPDATE drawings SET message_id = $1 WHERE id = $2', [message.id, drawing.id]);
      drawing.message_id = message.id;
      if (topic) await client.query('UPDATE forum_topics SET last_activity_at = clock_timestamp() WHERE id = $1', [topic]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (message) {
    const sender = await loadSender(query, userId);
    await broadcastChannelMessage(io, query, message, sender, { drawing: { id: Number(drawing.id), title }, topicId: topic });
    io.to(`channel_${channelId}`).emit('drawing_created', { channelId, topicId: topic, drawingId: Number(drawing.id) });
  }
  return {
    drawing: serializeDrawing(drawing, { role: 'editor', ownerUsername: person.username }),
    message: message ? { id: message.id, topicId: topic } : undefined,
  };
}

// An independent copy (scene and pictures) in a channel or topic, owned by the person sharing it.
async function copyDrawing(ctx, { userId, sourceId, channelId, topicId = null }) {
  const source = (await ctx.query('SELECT title, scene FROM drawings WHERE id = $1', [sourceId])).rows[0];
  const files = (await ctx.query('SELECT file_key, mime, bytes FROM drawing_files WHERE drawing_id = $1', [sourceId])).rows;
  return createDrawing(ctx, {
    userId, title: source.title, channelId, topicId, scene: source.scene,
    images: files.map((file) => ({ key: file.file_key, mime: file.mime, bytes: file.bytes })),
  });
}

// Deletes a drawing and turns its card into "Drawing removed". A moderator removing someone else's drawing is audited.
async function deleteDrawing({ io, query }, { drawing, actorId }) {
  await query('DELETE FROM drawings WHERE id = $1', [drawing.id]);
  if (drawing.message_id) {
    await query("UPDATE messages SET content = 'Drawing removed' WHERE id = $1", [drawing.message_id]);
    io.to(`channel_${drawing.channel_id}`).emit('message_updated', {
      messageId: drawing.message_id, channelId: drawing.channel_id, topicId: drawing.topic_id, content: 'Drawing removed', drawingRemoved: true,
    });
  }
  io.to(`drawing_${drawing.id}`).emit('drawing:removed', { drawingId: Number(drawing.id) });
  if (drawing.channel_id && Number(drawing.owner_id) !== Number(actorId)) {
    await query(
      'INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details) VALUES ($1, $2, $3, $4, $5)',
      [drawing.channel_id, actorId, drawing.owner_id, 'drawing_deleted', JSON.stringify({ drawingId: Number(drawing.id), title: drawing.title })]
    );
  }
}

// May this person delete the drawing? Its owner, or (for a channel or topic drawing) a channel or forum moderator.
async function mayDeleteDrawing(query, userId, drawing) {
  if (Number(drawing.owner_id) === Number(userId)) return true;
  if (!drawing.channel_id) return false;
  try { await ensureChannelModerator(query, userId, drawing.channel_id); return true; } catch (err) { if (err.status === 403) return false; throw err; }
}

module.exports = {
  MAX_TITLE, IMAGE_TYPES, cleanTitle, decodeImage, decodeImages, decodePreview, MAX_PREVIEW_BYTES, previewVersionOf, validateScene, serializeDrawing, kindOf,
  drawingsForMessages, createDrawing, copyDrawing, deleteDrawing, mayDeleteDrawing,
};
