const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

const TYPES = ['mention', 'reply', 'reaction'];

// One query per event kind. The feed is limited to channels the user can still see.
const SOURCES = {
  mention: `
    SELECT 'mention' AS type, m.id AS message_id, m.channel_id, c.name AS channel_name,
           u.id AS actor_id, u.username AS actor_username, u.avatar_color AS actor_avatar_color,
           m.content AS preview, NULL::text AS emoji, mm.created_at
    FROM message_mentions mm
    JOIN messages m ON m.id = mm.message_id
    JOIN channels c ON c.id = m.channel_id
    JOIN users u ON u.id = m.user_id
    WHERE mm.user_id = $1 AND m.user_id <> $1`,
  reply: `
    SELECT 'reply' AS type, m.id AS message_id, m.channel_id, c.name AS channel_name,
           u.id AS actor_id, u.username AS actor_username, u.avatar_color AS actor_avatar_color,
           m.content AS preview, NULL::text AS emoji, m.created_at
    FROM messages m
    JOIN messages parent ON parent.id = m.reply_to
    JOIN channels c ON c.id = m.channel_id
    JOIN users u ON u.id = m.user_id
    WHERE parent.user_id = $1 AND m.user_id <> $1`,
  reaction: `
    SELECT 'reaction' AS type, m.id AS message_id, m.channel_id, c.name AS channel_name,
           u.id AS actor_id, u.username AS actor_username, u.avatar_color AS actor_avatar_color,
           m.content AS preview, r.emoji::text AS emoji, r.created_at
    FROM reactions r
    JOIN messages m ON m.id = r.message_id
    JOIN channels c ON c.id = m.channel_id
    JOIN users u ON u.id = r.user_id
    WHERE m.user_id = $1 AND r.user_id <> $1`,
};

function feedSql(types) {
  const union = types.map((type) => SOURCES[type]).join('\n UNION ALL \n');
  return `
    SELECT e.* FROM (${union}) e
    WHERE EXISTS (
      SELECT 1 FROM users me
      WHERE me.id = $1 AND (me.is_superadmin = TRUE OR EXISTS (
        SELECT 1 FROM channel_members cm WHERE cm.channel_id = e.channel_id AND cm.user_id = $1
      ))
    )`;
}

// GET /api/activity?type=all|mention|reply|reaction&limit=50
router.get('/', async (req, res) => {
  try {
    const requested = String(req.query.type || 'all');
    if (requested !== 'all' && !TYPES.includes(requested)) {
      return res.status(400).json({ error: 'Type must be all, mention, reply, or reaction' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const types = requested === 'all' ? TYPES : [requested];

    const [items, account] = await Promise.all([
      query(`${feedSql(types)} ORDER BY e.created_at DESC LIMIT $2`, [req.user.userId, limit]),
      query('SELECT activity_seen_at FROM users WHERE id = $1', [req.user.userId]),
    ]);
    const seenAt = account.rows[0]?.activity_seen_at || null;
    const unseen = await query(
      `SELECT COUNT(*)::int AS count FROM (${feedSql(TYPES)}) feed
       WHERE $2::timestamptz IS NULL OR feed.created_at > $2::timestamptz`,
      [req.user.userId, seenAt]
    );

    res.json({
      seenAt,
      unseenCount: unseen.rows[0]?.count || 0,
      items: items.rows.map((row) => ({
        type: row.type,
        messageId: row.message_id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        actorId: row.actor_id,
        actorUsername: row.actor_username,
        actorAvatarColor: row.actor_avatar_color,
        preview: String(row.preview || '').slice(0, 200),
        emoji: row.emoji,
        createdAt: row.created_at,
        unseen: !seenAt || new Date(row.created_at) > new Date(seenAt),
      })),
    });
  } catch (err) {
    console.error('Get activity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/activity/seen - everything up to now counts as seen
router.post('/seen', async (req, res) => {
  try {
    const result = await query(
      'UPDATE users SET activity_seen_at = NOW() WHERE id = $1 RETURNING activity_seen_at',
      [req.user.userId]
    );
    res.json({ seenAt: result.rows[0]?.activity_seen_at || null });
  } catch (err) {
    console.error('Mark activity seen error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
