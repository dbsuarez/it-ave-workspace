const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership, ensureDirectMessageAccess } = require('../security');
const { parseRemindAt } = require('./reminders');
const { postChannelMessage, postDirectMessage } = require('../messageDelivery');

// Messages written now and sent later, to a channel or to one person.
const router = express.Router();
router.use(authenticateToken);

const MAX_PENDING = 50;
const MAX_LENGTH = 10000;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

const SELECT = `
  SELECT s.id, s.channel_id, s.receiver_id, s.content, s.send_at, s.sent_at, s.failed_at, s.error,
         s.created_at, c.name AS channel_name, u.username AS receiver_username
  FROM scheduled_messages s
  LEFT JOIN channels c ON c.id = s.channel_id
  LEFT JOIN users u ON u.id = s.receiver_id`;

function serialize(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name || null,
    receiverId: row.receiver_id,
    receiverUsername: row.receiver_username || null,
    content: row.content,
    sendAt: row.send_at,
    sentAt: row.sent_at,
    failedAt: row.failed_at,
    error: row.error || null,
    createdAt: row.created_at,
  };
}

// Pending messages, plus any that failed to send (so the author can see why).
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `${SELECT} WHERE s.user_id = $1 AND s.sent_at IS NULL ORDER BY s.send_at`,
      [req.user.userId]
    );
    res.json({ scheduled: result.rows.map(serialize) });
  } catch (err) {
    sendError(res, err, 'List scheduled messages error');
  }
});

router.post('/', async (req, res) => {
  try {
    const channelId = req.body?.channelId == null ? null : parseId(req.body.channelId);
    const receiverId = req.body?.receiverId == null ? null : parseId(req.body.receiverId);
    if ((channelId === null) === (receiverId === null)) {
      return res.status(400).json({ error: 'Provide exactly one of channelId or receiverId' });
    }
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'Message content is required' });
    if (content.length > MAX_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MAX_LENGTH} characters or fewer` });
    }
    const sendAt = parseRemindAt(req.body?.sendAt);

    if (channelId) await ensureChannelMembership(query, req.user.userId, channelId);
    else await ensureDirectMessageAccess(query, req.user.userId, receiverId);

    const pending = await query(
      'SELECT COUNT(*)::int AS count FROM scheduled_messages WHERE user_id = $1 AND sent_at IS NULL AND failed_at IS NULL',
      [req.user.userId]
    );
    if (pending.rows[0].count >= MAX_PENDING) {
      return res.status(400).json({ error: `You can have at most ${MAX_PENDING} scheduled messages` });
    }

    const created = await query(
      `INSERT INTO scheduled_messages (user_id, channel_id, receiver_id, content, send_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.userId, channelId, receiverId, content, sendAt]
    );
    const row = await query(`${SELECT} WHERE s.id = $1`, [created.rows[0].id]);
    res.status(201).json({ scheduled: serialize(row.rows[0]) });
  } catch (err) {
    // parseRemindAt words its errors for reminders; reword for sendAt.
    if (err.status === 400 && /remindAt/.test(err.message)) {
      return res.status(400).json({ error: err.message.replace('remindAt', 'sendAt') });
    }
    sendError(res, err, 'Schedule message error');
  }
});

// Cancel a pending (or failed) scheduled message.
router.delete('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid scheduled message ID is required' });
    const removed = await query(
      'DELETE FROM scheduled_messages WHERE id = $1 AND user_id = $2 AND sent_at IS NULL RETURNING id',
      [id, req.user.userId]
    );
    if (!removed.rows.length) return res.status(404).json({ error: 'Scheduled message not found' });
    res.json({ canceled: true });
  } catch (err) {
    sendError(res, err, 'Cancel scheduled message error');
  }
});

// Sends everything that is due. A message that can no longer be sent (the
// author lost access, was timed out, ...) is marked failed and reported.
async function deliverDueScheduledMessages(io) {
  const due = await query(
    `SELECT id, user_id, channel_id, receiver_id, content
     FROM scheduled_messages
     WHERE sent_at IS NULL AND failed_at IS NULL AND send_at <= NOW()
     ORDER BY send_at LIMIT 100`
  );
  for (const row of due.rows) {
    // Claim the row first so a slow send cannot be picked up twice.
    const claimed = await query(
      'UPDATE scheduled_messages SET sent_at = NOW() WHERE id = $1 AND sent_at IS NULL RETURNING id',
      [row.id]
    );
    if (!claimed.rows.length) continue;
    try {
      if (row.channel_id) {
        await postChannelMessage(io, query, { userId: row.user_id, channelId: row.channel_id, content: row.content });
      } else {
        await postDirectMessage(io, query, { userId: row.user_id, receiverId: row.receiver_id, content: row.content });
      }
      io.to(`user_${row.user_id}`).emit('scheduled_message_sent', { id: row.id });
    } catch (err) {
      const reason = String(err.message || 'Could not send').slice(0, 300);
      await query(
        'UPDATE scheduled_messages SET sent_at = NULL, failed_at = NOW(), error = $2 WHERE id = $1',
        [row.id, reason]
      );
      io.to(`user_${row.user_id}`).emit('scheduled_message_failed', { id: row.id, error: reason });
    }
  }
  return due.rows.length;
}

function startScheduledMessageRunner(io, intervalMs = 15000) {
  const timer = setInterval(() => {
    deliverDueScheduledMessages(io).catch((err) => console.error('Scheduled message delivery error:', err));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = router;
module.exports.deliverDueScheduledMessages = deliverDueScheduledMessages;
module.exports.startScheduledMessageRunner = startScheduledMessageRunner;
