const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

const NOTIFICATION_DEFAULTS = Object.freeze({
  mentions: true,
  directMessages: true,
  replies: true,
  reactions: true,
  channelMessages: false,
  desktop: true,
  sound: true,
});
const MAX_DND_MINUTES = 7 * 24 * 60;

function mergeNotificationPrefs(stored, changes) {
  const merged = { ...NOTIFICATION_DEFAULTS };
  for (const key of Object.keys(NOTIFICATION_DEFAULTS)) {
    if (stored && typeof stored[key] === 'boolean') merged[key] = stored[key];
  }
  if (changes !== undefined) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw Object.assign(new Error('Notifications must be an object of on/off settings'), { status: 400 });
    }
    for (const [key, value] of Object.entries(changes)) {
      if (!(key in NOTIFICATION_DEFAULTS)) {
        throw Object.assign(new Error(`Unknown notification setting: ${key}`), { status: 400 });
      }
      if (typeof value !== 'boolean') {
        throw Object.assign(new Error(`Notification setting ${key} must be true or false`), { status: 400 });
      }
      merged[key] = value;
    }
  }
  return merged;
}

// A single emoji (or nothing). Uses the same grapheme rule as reactions.
function isSingleEmojiOrEmpty(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 16) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(value);
}

function serialize(row) {
  const dndUntil = row.dnd_until && new Date(row.dnd_until) > new Date() ? row.dnd_until : null;
  return {
    notifications: mergeNotificationPrefs(row.notification_prefs),
    dndUntil,
    statusText: row.status_text || '',
    statusEmoji: row.status_emoji || '',
  };
}

router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT notification_prefs, dnd_until, status_text, status_emoji FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ settings: serialize(result.rows[0]) });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/settings - partial update. `dndMinutes` of 0 turns Do Not Disturb off.
router.put('/', async (req, res) => {
  try {
    const { notifications, dndMinutes, statusText, statusEmoji } = req.body || {};
    const current = await query(
      'SELECT notification_prefs, dnd_until, status_text, status_emoji FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'User not found' });
    const row = current.rows[0];

    const prefs = mergeNotificationPrefs(row.notification_prefs, notifications);

    let dndUntil = row.dnd_until;
    if (dndMinutes !== undefined) {
      if (!Number.isInteger(dndMinutes) || dndMinutes < 0 || dndMinutes > MAX_DND_MINUTES) {
        return res.status(400).json({ error: `Pause duration must be a whole number of minutes from 0 to ${MAX_DND_MINUTES}` });
      }
      dndUntil = dndMinutes === 0 ? null : new Date(Date.now() + dndMinutes * 60 * 1000);
    }

    let text = row.status_text || '';
    if (statusText !== undefined) {
      if (typeof statusText !== 'string' || statusText.trim().length > 100) {
        return res.status(400).json({ error: 'Status must be 100 characters or fewer' });
      }
      text = statusText.trim();
    }

    let emoji = row.status_emoji || '';
    if (statusEmoji !== undefined) {
      if (!isSingleEmojiOrEmpty(statusEmoji)) {
        return res.status(400).json({ error: 'Status emoji must be a single emoji or empty' });
      }
      emoji = statusEmoji;
    }

    const updated = await query(
      `UPDATE users
       SET notification_prefs = $1, dnd_until = $2, status_text = $3, status_emoji = $4
       WHERE id = $5
       RETURNING notification_prefs, dnd_until, status_text, status_emoji`,
      [JSON.stringify(prefs), dndUntil, text, emoji, req.user.userId]
    );
    const settings = serialize(updated.rows[0]);

    // Everyone sees status and whether notifications are paused.
    req.io?.emit('user_status_updated', {
      userId: req.user.userId,
      statusText: settings.statusText,
      statusEmoji: settings.statusEmoji,
      dndUntil: settings.dndUntil,
    });
    res.json({ settings });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Personal sidebar sections ----
const MAX_SECTIONS = 20;

// Validates and normalises a sidebar layout: named sections, each holding
// channel IDs. A channel can sit in at most one section.
function normalizeSidebarLayout(input) {
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  if (!input || typeof input !== 'object' || !Array.isArray(input.sections)) {
    throw fail('Layout must have a list of sections');
  }
  if (input.sections.length > MAX_SECTIONS) throw fail(`You can have at most ${MAX_SECTIONS} sections`);
  const seenIds = new Set();
  const seenChannels = new Set();
  const sections = input.sections.map((section) => {
    const id = typeof section?.id === 'string' ? section.id.trim() : '';
    const name = typeof section?.name === 'string' ? section.name.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw fail('Each section needs a short ID');
    if (seenIds.has(id)) throw fail('Section IDs must be unique');
    seenIds.add(id);
    if (!name || name.length > 40) throw fail('Section names must be 1 to 40 characters');
    if (!Array.isArray(section.channelIds)) throw fail('Each section needs a list of channel IDs');
    const channelIds = [];
    for (const raw of section.channelIds) {
      const channelId = Number(raw);
      if (!Number.isSafeInteger(channelId) || channelId < 1) throw fail('Channel IDs must be positive whole numbers');
      if (seenChannels.has(channelId)) throw fail('A channel can only be in one section');
      seenChannels.add(channelId);
      channelIds.push(channelId);
    }
    return { id, name, channelIds, collapsed: Boolean(section.collapsed) };
  });
  return { sections };
}

router.get('/sidebar', async (req, res) => {
  try {
    const result = await query('SELECT sidebar_layout FROM users WHERE id = $1', [req.user.userId]);
    const stored = result.rows[0]?.sidebar_layout;
    res.json({ layout: stored && Array.isArray(stored.sections) ? stored : { sections: [] } });
  } catch (err) {
    console.error('Get sidebar layout error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/sidebar', async (req, res) => {
  try {
    const layout = normalizeSidebarLayout(req.body?.layout);
    await query('UPDATE users SET sidebar_layout = $1 WHERE id = $2', [JSON.stringify(layout), req.user.userId]);
    res.json({ layout });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Save sidebar layout error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.normalizeSidebarLayout = normalizeSidebarLayout;
module.exports.mergeNotificationPrefs = mergeNotificationPrefs;
module.exports.isSingleEmojiOrEmpty = isSingleEmojiOrEmpty;
module.exports.NOTIFICATION_DEFAULTS = NOTIFICATION_DEFAULTS;
