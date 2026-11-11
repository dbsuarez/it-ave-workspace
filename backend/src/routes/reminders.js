const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership } = require('../security');

// Personal reminders, optionally linked to a channel message.
const router = express.Router();
router.use(authenticateToken);

const MAX_PENDING = 100;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

// Validates a requested reminder time. `now` is injectable for tests.
function parseRemindAt(value, now = Date.now()) {
  if (typeof value !== 'string' || !value) {
    throw Object.assign(new Error('remindAt must be a date and time'), { status: 400 });
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw Object.assign(new Error('remindAt must be a valid date and time'), { status: 400 });
  }
  if (time <= now) throw Object.assign(new Error('Choose a time in the future'), { status: 400 });
  if (time > now + MAX_AHEAD_MS) {
    throw Object.assign(new Error('Reminders can be set at most one year ahead'), { status: 400 });
  }
  return new Date(time);
}

function serialize(row) {
  return {
    id: row.id,
    text: row.text,
    remindAt: row.remind_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    messageId: row.message_id,
    channelId: row.channel_id || null,
    channelName: row.channel_name || null,
    messagePreview: row.message_content ? String(row.message_content).slice(0, 200) : null,
  };
}

const SELECT = `
  SELECT r.id, r.text, r.remind_at, r.delivered_at, r.created_at, r.message_id,
         m.channel_id, m.content AS message_content, c.name AS channel_name
  FROM reminders r
  LEFT JOIN messages m ON m.id = r.message_id
  LEFT JOIN channels c ON c.id = m.channel_id`;

router.get('/', async (req, res) => {
  try {
    const result = await query(
      `${SELECT} WHERE r.user_id = $1 ORDER BY (r.delivered_at IS NOT NULL), r.remind_at`,
      [req.user.userId]
    );
    res.json({ reminders: result.rows.map(serialize) });
  } catch (err) {
    sendError(res, err, 'List reminders error');
  }
});

router.post('/', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const messageId = req.body?.messageId === undefined || req.body?.messageId === null
      ? null : parseId(req.body.messageId);
    if (req.body?.messageId !== undefined && req.body?.messageId !== null && !messageId) {
      return res.status(400).json({ error: 'messageId must be a valid message ID' });
    }
    if (!text && !messageId) return res.status(400).json({ error: 'Say what to be reminded about' });
    if (text.length > 500) return res.status(400).json({ error: 'Reminder text must be 500 characters or fewer' });
    const remindAt = parseRemindAt(req.body?.remindAt);

    if (messageId) {
      const message = await query('SELECT channel_id FROM messages WHERE id = $1', [messageId]);
      if (!message.rows.length) return res.status(404).json({ error: 'Message not found' });
      await ensureChannelMembership(query, req.user.userId, message.rows[0].channel_id);
    }

    const pending = await query(
      'SELECT COUNT(*)::int AS count FROM reminders WHERE user_id = $1 AND delivered_at IS NULL',
      [req.user.userId]
    );
    if (pending.rows[0].count >= MAX_PENDING) {
      return res.status(400).json({ error: `You can have at most ${MAX_PENDING} pending reminders` });
    }

    const created = await query(
      'INSERT INTO reminders (user_id, text, message_id, remind_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.user.userId, text, messageId, remindAt]
    );
    const row = await query(`${SELECT} WHERE r.id = $1`, [created.rows[0].id]);
    res.status(201).json({ reminder: serialize(row.rows[0]) });
  } catch (err) {
    sendError(res, err, 'Create reminder error');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid reminder ID is required' });
    const removed = await query(
      'DELETE FROM reminders WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.userId]
    );
    if (!removed.rows.length) return res.status(404).json({ error: 'Reminder not found' });
    res.json({ removed: true });
  } catch (err) {
    sendError(res, err, 'Delete reminder error');
  }
});

// Delivers due reminders to their owners' sockets. Returns how many were sent.
async function deliverDueReminders(io) {
  const due = await query(
    `UPDATE reminders SET delivered_at = NOW()
     WHERE id IN (
       SELECT id FROM reminders
       WHERE delivered_at IS NULL AND remind_at <= NOW()
       ORDER BY remind_at LIMIT 200
     )
     RETURNING id, user_id`
  );
  for (const row of due.rows) {
    const detail = await query(`${SELECT} WHERE r.id = $1`, [row.id]);
    if (detail.rows.length) {
      io.to(`user_${row.user_id}`).emit('reminder_due', { reminder: serialize(detail.rows[0]) });
    }
  }
  return due.rows.length;
}

function startReminderScheduler(io, intervalMs = 15000) {
  const timer = setInterval(() => {
    deliverDueReminders(io).catch((err) => console.error('Reminder delivery error:', err));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = router;
module.exports.parseRemindAt = parseRemindAt;
module.exports.deliverDueReminders = deliverDueReminders;
module.exports.startReminderScheduler = startReminderScheduler;
