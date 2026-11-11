const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelModerator } = require('../security');
const { postChannelMessage } = require('../messageDelivery');

// Incoming webhooks: an outside system posts { "text": "..." } to a secret
// URL and the text appears in one channel under the webhook's name.
//
// `manage` is mounted on /api/webhooks (signed-in moderators).
// `receive` is mounted on /api/hooks (public; the URL token is the secret).
const manage = express.Router();
const receive = express.Router();

const MAX_TEXT = 4000;
const MAX_PER_CHANNEL = 10;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;
const recentCalls = new Map();

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Sliding one-minute window per webhook. Returns true when the call is allowed.
function allowWebhookCall(key, now = Date.now(), limit = RATE_MAX) {
  const recent = (recentCalls.get(key) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (recent.length >= limit) {
    recentCalls.set(key, recent);
    return false;
  }
  recent.push(now);
  recentCalls.set(key, recent);
  return true;
}

function serialize(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    createdBy: row.created_by_username || 'former user',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

manage.use(authenticateToken);

manage.get('/', async (req, res) => {
  try {
    const channelId = parseId(req.query.channelId);
    if (!channelId) return res.status(400).json({ error: 'A valid channel ID is required' });
    await ensureChannelModerator(query, req.user.userId, channelId);
    const result = await query(
      `SELECT w.*, u.username AS created_by_username
       FROM webhooks w LEFT JOIN users u ON u.id = w.created_by
       WHERE w.channel_id = $1 ORDER BY w.created_at`,
      [channelId]
    );
    res.json({ webhooks: result.rows.map(serialize) });
  } catch (err) {
    sendError(res, err, 'List webhooks error');
  }
});

// Creates a webhook and its posting identity. The secret path is returned once.
manage.post('/', async (req, res) => {
  try {
    const channelId = parseId(req.body?.channelId);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!channelId) return res.status(400).json({ error: 'A valid channel ID is required' });
    if (name.length < 2 || name.length > 40) {
      return res.status(400).json({ error: 'Name must be 2 to 40 characters' });
    }
    await ensureChannelModerator(query, req.user.userId, channelId);
    const count = await query('SELECT COUNT(*)::int AS count FROM webhooks WHERE channel_id = $1', [channelId]);
    if (count.rows[0].count >= MAX_PER_CHANNEL) {
      return res.status(400).json({ error: `A channel can have at most ${MAX_PER_CHANNEL} webhooks` });
    }

    // Messages need an author, so each webhook gets a bot account that can
    // never sign in (random password) and is hidden from people lists.
    const suffix = crypto.randomBytes(3).toString('hex');
    const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    const bot = await query(
      `INSERT INTO users (username, email, password_hash, account_type, status)
       VALUES ($1, $2, $3, 'bot', 'offline') RETURNING id`,
      [`${name} (app ${suffix})`, `webhook-${suffix}-${Date.now()}@bots.invalid`, passwordHash]
    );
    const botId = bot.rows[0].id;
    await query(
      'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [channelId, botId]
    );

    const token = crypto.randomBytes(24).toString('base64url');
    const created = await query(
      `INSERT INTO webhooks (channel_id, name, token_hash, bot_user_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [channelId, name, hashToken(token), botId, req.user.userId]
    );
    res.status(201).json({ path: `/api/hooks/${token}`, webhook: serialize(created.rows[0]) });
  } catch (err) {
    sendError(res, err, 'Create webhook error');
  }
});

manage.delete('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid webhook ID is required' });
    const webhook = await query('SELECT channel_id, bot_user_id FROM webhooks WHERE id = $1', [id]);
    if (!webhook.rows.length) return res.status(404).json({ error: 'Webhook not found' });
    await ensureChannelModerator(query, req.user.userId, webhook.rows[0].channel_id);
    await query('DELETE FROM webhooks WHERE id = $1', [id]);
    // The bot leaves the channel but stays as the author of what it posted.
    if (webhook.rows[0].bot_user_id) {
      await query(
        'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
        [webhook.rows[0].channel_id, webhook.rows[0].bot_user_id]
      );
    }
    res.json({ removed: true });
  } catch (err) {
    sendError(res, err, 'Delete webhook error');
  }
});

receive.post('/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (token.length < 20 || token.length > 100) return res.status(404).json({ error: 'Unknown webhook' });
    const found = await query(
      'SELECT id, channel_id, bot_user_id FROM webhooks WHERE token_hash = $1',
      [hashToken(token)]
    );
    if (!found.rows.length) return res.status(404).json({ error: 'Unknown webhook' });
    const webhook = found.rows[0];

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Send JSON with a non-empty "text" field' });
    if (text.length > MAX_TEXT) return res.status(400).json({ error: `Text must be ${MAX_TEXT} characters or fewer` });
    if (!allowWebhookCall(webhook.id)) {
      return res.status(429).json({ error: `Too many messages; the limit is ${RATE_MAX} per minute` });
    }

    const message = await postChannelMessage(req.io, query, {
      userId: webhook.bot_user_id,
      channelId: webhook.channel_id,
      content: text,
    });
    await query('UPDATE webhooks SET last_used_at = NOW() WHERE id = $1', [webhook.id]);
    res.json({ ok: true, messageId: message.id });
  } catch (err) {
    sendError(res, err, 'Receive webhook error');
  }
});

module.exports = { manage, receive, allowWebhookCall };
