// Department forums: topics. Every request re-checks channel access (so moving a person out of the department closes the
// forum for them at once); the department head, a channel moderator or a manage_messages holder moderates.
const express = require('express');
const { query, pool } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership, ensureChannelModerator, ensureChannelNotArchived, ensureCanPostToChannel } = require('../security');
const { insertChannelMessage, parseAttachmentIds, ATTACHMENT_UNAVAILABLE } = require('../attachments');
const forums = require('../forums');

const router = express.Router();
router.use(authenticateToken);

const MAX_TITLE = 120;
const MAX_POST = 10000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const parseId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);
function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

// The forum channel, once the caller is known to be allowed in it.
async function openForum(userId, channelId) {
  if (!channelId) throw fail(400, 'A valid forum is required');
  await ensureChannelMembership(query, userId, channelId);
  const channel = (await query('SELECT id, kind, name FROM channels WHERE id = $1', [channelId])).rows[0];
  if (!channel || channel.kind !== 'forum') throw fail(400, 'That channel is not a forum');
  return channel;
}

async function isModerator(userId, channelId) {
  try { await ensureChannelModerator(query, userId, channelId); return true; } catch (err) { if (err.status === 403) return false; throw err; }
}

const audit = (channelId, actorId, action, topic, extra = {}) => query(
  'INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details) VALUES ($1, $2, $3, $4, $5)',
  [channelId, actorId, topic.authorId || null, action, JSON.stringify({ topicId: topic.id, title: topic.title, ...extra })]
);

function cleanTitle(value) {
  if (typeof value !== 'string') throw fail(400, 'A topic needs a title');
  const title = value.trim();
  if (!title) throw fail(400, 'A topic needs a title');
  if (title.length > MAX_TITLE) throw fail(400, `A title can be at most ${MAX_TITLE} characters`);
  return title;
}

router.get('/:channelId/topics', async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    await openForum(req.user.userId, channelId);
    const offset = parseId(req.query.offset) || 0;
    res.json(await forums.listTopics(query, channelId, { archived: req.query.archived === '1', offset }));
  } catch (err) { sendError(res, err, 'List topics error'); }
});

// One topic (to open it from a link, a search result or a notification).
router.get('/topics/:topicId', async (req, res) => {
  try {
    const topicId = parseId(req.params.topicId);
    if (!topicId) throw fail(400, 'A valid topic is required');
    const topic = await forums.loadTopic(query, topicId);
    await openForum(req.user.userId, topic.channelId);
    res.json({ topic });
  } catch (err) { sendError(res, err, 'Get topic error'); }
});

// Starts a topic: the topic row and its opening post are created together, or not at all.
router.post('/:channelId/topics', async (req, res) => {
  const body = req.body || {};
  try {
    const channelId = parseId(req.params.channelId);
    await openForum(req.user.userId, channelId);
    const title = cleanTitle(body.title);
    const attachments = parseAttachmentIds({ attachmentIds: body.attachmentIds });
    if (!attachments.ok) throw fail(400, 'Attachments must be a list of up to 10 uploads');
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (body.content !== undefined && typeof body.content !== 'string') throw fail(400, 'The post must be text');
    if (!content && !attachments.ids.length) throw fail(400, 'Write the first post of the topic');
    if (content.length > MAX_POST) throw fail(400, `A post can be at most ${MAX_POST} characters`);
    await ensureCanPostToChannel(query, req.user.userId, channelId);

    const client = await pool.connect();
    let topicId;
    let message;
    try {
      await client.query('BEGIN');
      topicId = (await client.query('INSERT INTO forum_topics (channel_id, title, created_by) VALUES ($1, $2, $3) RETURNING id', [channelId, title, req.user.userId])).rows[0].id;
      message = await insertChannelMessage((...args) => client.query(...args), { channelId, userId: req.user.userId, content, attachmentIds: attachments.ids, topicId });
      if (!message) throw fail(400, ATTACHMENT_UNAVAILABLE);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const topic = await forums.loadTopic(query, topicId);
    req.io?.to(`channel_${channelId}`).emit('forum_topic_created', { channelId, topicId: topic.id });
    res.status(201).json({ topic, message: { id: message.id, content: message.content, createdAt: message.created_at, topicId: topic.id } });
  } catch (err) { sendError(res, err, 'Create topic error'); }
});

// Rename: the author (while the topic is open) or a moderator. Pin, lock and archive: moderators only.
router.patch('/topics/:topicId', async (req, res) => {
  const body = req.body || {};
  try {
    const topicId = parseId(req.params.topicId);
    if (!topicId) throw fail(400, 'A valid topic is required');
    const topic = await forums.loadTopic(query, topicId);
    await openForum(req.user.userId, topic.channelId);
    const flags = ['pinned', 'locked', 'archived'].filter((key) => body[key] !== undefined);
    for (const key of flags) if (typeof body[key] !== 'boolean') throw fail(400, `${key} must be true or false`);
    const title = body.title === undefined ? undefined : cleanTitle(body.title);
    if (title === undefined && !flags.length) throw fail(400, 'Nothing to change');
    const moderator = await isModerator(req.user.userId, topic.channelId);
    if (flags.length && !moderator) throw fail(403, 'Only a moderator can pin, lock or archive a topic');
    const author = Number(topic.authorId) === Number(req.user.userId);
    if (title !== undefined && !moderator && !author) throw fail(403, 'Only the author or a moderator can rename a topic');
    await ensureChannelNotArchived(query, topic.channelId);
    if (title !== undefined && !moderator && (topic.lockedAt || topic.archivedAt)) throw fail(409, 'This topic is locked');

    const changes = [];
    const sets = [];
    const values = [topicId];
    const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };
    if (title !== undefined && title !== topic.title) { set('title', title); changes.push(['forum_topic_renamed', { from: topic.title }]); }
    const states = { pinned: ['pinned_at', topic.pinnedAt], locked: ['locked_at', topic.lockedAt], archived: ['archived_at', topic.archivedAt] };
    for (const key of flags) {
      const [column, current] = states[key];
      if (Boolean(current) === body[key]) continue;
      // clock_timestamp() is read once the row lock is held, so a lock that waited for a reply is stamped after that reply
      sets.push(`${column} = ${body[key] ? 'clock_timestamp()' : 'NULL'}`);
      changes.push([`forum_topic_${body[key] ? '' : 'un'}${key}`, {}]);
    }
    if (sets.length) await query(`UPDATE forum_topics SET ${sets.join(', ')} WHERE id = $1`, values);
    for (const [action, extra] of changes) await audit(topic.channelId, req.user.userId, action, { ...topic, title: title ?? topic.title }, extra);
    const updated = await forums.loadTopic(query, topicId);
    req.io?.to(`channel_${topic.channelId}`).emit('forum_topic_updated', { channelId: topic.channelId, topicId });
    res.json({ topic: updated });
  } catch (err) { sendError(res, err, 'Update topic error'); }
});

// Delete: a moderator any time; the author only while nobody has replied. The posts go with the topic.
router.delete('/topics/:topicId', async (req, res) => {
  try {
    const topicId = parseId(req.params.topicId);
    if (!topicId) throw fail(400, 'A valid topic is required');
    const topic = await forums.loadTopic(query, topicId);
    await openForum(req.user.userId, topic.channelId);
    const moderator = await isModerator(req.user.userId, topic.channelId);
    const author = Number(topic.authorId) === Number(req.user.userId);
    if (!moderator && !author) throw fail(403, 'Only the author or a moderator can delete a topic');
    await ensureChannelNotArchived(query, topic.channelId);
    if (!moderator && topic.replyCount > 0) throw fail(409, 'This topic has replies; ask a moderator to delete it');
    await query('DELETE FROM forum_topics WHERE id = $1', [topicId]);
    await audit(topic.channelId, req.user.userId, 'forum_topic_deleted', topic, { replies: topic.replyCount });
    req.io?.to(`channel_${topic.channelId}`).emit('forum_topic_deleted', { channelId: topic.channelId, topicId });
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Delete topic error'); }
});

module.exports = router;
