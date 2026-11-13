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
           CASE WHEN u.photo_file IS NOT NULL AND u.photo_updated_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM u.photo_updated_at) * 1000 END AS actor_photo_version,
           m.content AS preview, NULL::text AS emoji, mm.created_at
    FROM message_mentions mm
    JOIN messages m ON m.id = mm.message_id
    JOIN channels c ON c.id = m.channel_id
    JOIN users u ON u.id = m.user_id
    WHERE mm.user_id = $1 AND m.user_id <> $1`,
  reply: `
    SELECT 'reply' AS type, m.id AS message_id, m.channel_id, c.name AS channel_name,
           u.id AS actor_id, u.username AS actor_username, u.avatar_color AS actor_avatar_color,
           CASE WHEN u.photo_file IS NOT NULL AND u.photo_updated_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM u.photo_updated_at) * 1000 END AS actor_photo_version,
           m.content AS preview, NULL::text AS emoji, m.created_at
    FROM messages m
    JOIN messages parent ON parent.id = m.reply_to
    JOIN channels c ON c.id = m.channel_id
    JOIN users u ON u.id = m.user_id
    WHERE parent.user_id = $1 AND m.user_id <> $1`,
  reaction: `
    SELECT 'reaction' AS type, m.id AS message_id, m.channel_id, c.name AS channel_name,
           u.id AS actor_id, u.username AS actor_username, u.avatar_color AS actor_avatar_color,
           CASE WHEN u.photo_file IS NOT NULL AND u.photo_updated_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM u.photo_updated_at) * 1000 END AS actor_photo_version,
           m.content AS preview, r.emoji::text AS emoji, r.created_at
    FROM reactions r
    JOIN messages m ON m.id = r.message_id
    JOIN channels c ON c.id = m.channel_id
    JOIN users u ON u.id = r.user_id
    WHERE m.user_id = $1 AND r.user_id <> $1`,
};

// Canvas mentions and replies, for canvases the person can still read (and that are not in the trash).
const CANVAS_ITEMS_SQL = `
  SELECT cm.id, cm.source, cm.snippet AS preview, cm.created_at, cm.canvas_id,
         c.kind AS canvas_kind, c.title AS canvas_title, c.channel_id, ch.name AS channel_name,
         u.id AS actor_id, u.username AS actor_username, u.avatar_color AS actor_avatar_color,
         CASE WHEN u.photo_file IS NOT NULL AND u.photo_updated_at IS NOT NULL
           THEN EXTRACT(EPOCH FROM u.photo_updated_at) * 1000 END AS actor_photo_version
  FROM canvas_mentions cm
  JOIN canvases c ON c.id = cm.canvas_id AND c.deleted_at IS NULL
  LEFT JOIN channels ch ON ch.id = c.channel_id
  LEFT JOIN users u ON u.id = cm.actor_id
  WHERE cm.user_id = $1
    AND (
      (c.kind = 'standalone' AND (
        COALESCE(c.owner_id, c.created_by) = $1
        OR EXISTS (SELECT 1 FROM canvas_collaborators WHERE canvas_id = c.id AND user_id = $1)
        OR EXISTS (SELECT 1 FROM canvas_channel_grants g JOIN channel_members m ON m.channel_id = g.channel_id
                   WHERE g.canvas_id = c.id AND m.user_id = $1)))
      OR (c.kind = 'channel' AND (
        EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.channel_id AND user_id = $1)
        OR EXISTS (SELECT 1 FROM users me JOIN channel_overrides co ON co.channel_id = c.channel_id
                   AND co.subject_type = 'department' AND co.subject_id = me.department_id
                   WHERE me.id = $1 AND 'view_channel' = ANY(co.allow))
      ))
      OR (c.kind = 'dm' AND $1 IN (c.dm_user_low, c.dm_user_high))
    )`;

function mapCanvasItem(row, seenAt) {
  return {
    type: 'canvas_mention',
    source: row.source,
    canvasId: row.canvas_id,
    canvasKind: row.canvas_kind,
    canvasTitle: row.canvas_title,
    channelId: row.channel_id,
    channelName: row.channel_name,
    actorId: row.actor_id,
    actorUsername: row.actor_username,
    actorAvatarColor: row.actor_avatar_color,
    actorPhotoVersion: row.actor_photo_version ? Number(row.actor_photo_version) : null,
    preview: String(row.preview || '').slice(0, 200),
    createdAt: row.created_at,
    unseen: !seenAt || new Date(row.created_at) > new Date(seenAt),
  };
}

function feedSql(types) {
  const union = types.map((type) => SOURCES[type]).join('\n UNION ALL \n');
  return `
    SELECT e.* FROM (${union}) e
    WHERE EXISTS (
      SELECT 1 FROM users me JOIN channels visible ON visible.id = e.channel_id
      WHERE me.id = $1 AND (
        (visible.is_personal = TRUE AND visible.created_by = me.id)
        OR (visible.is_personal = FALSE AND (me.is_superadmin = TRUE OR EXISTS (
          SELECT 1 FROM channel_members cm WHERE cm.channel_id = e.channel_id AND cm.user_id = me.id
        ) OR EXISTS (
          SELECT 1 FROM channel_overrides co WHERE co.channel_id = e.channel_id
            AND co.subject_type = 'department' AND co.subject_id = me.department_id
            AND 'view_channel' = ANY(co.allow)
        )))
      )
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

    const wantsCanvas = requested === 'all' || requested === 'mention';
    const [items, account, canvasItems] = await Promise.all([
      query(`${feedSql(types)} ORDER BY e.created_at DESC LIMIT $2`, [req.user.userId, limit]),
      query('SELECT activity_seen_at FROM users WHERE id = $1', [req.user.userId]),
      wantsCanvas ? query(`${CANVAS_ITEMS_SQL} ORDER BY cm.created_at DESC LIMIT $2`, [req.user.userId, limit]) : { rows: [] },
    ]);
    const seenAt = account.rows[0]?.activity_seen_at || null;
    const unseen = await query(
      `SELECT COUNT(*)::int AS count FROM (${feedSql(TYPES)}) feed
       WHERE $2::timestamptz IS NULL OR feed.created_at > $2::timestamptz`,
      [req.user.userId, seenAt]
    );
    const canvasUnseen = await query(
      `SELECT COUNT(*)::int AS count FROM (${CANVAS_ITEMS_SQL}) feed
       WHERE $2::timestamptz IS NULL OR feed.created_at > $2::timestamptz`,
      [req.user.userId, seenAt]
    );

    res.json({
      seenAt,
      unseenCount: (unseen.rows[0]?.count || 0) + (canvasUnseen.rows[0]?.count || 0),
      items: [...items.rows.map((row) => ({
        type: row.type,
        messageId: row.message_id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        actorId: row.actor_id,
        actorUsername: row.actor_username,
        actorAvatarColor: row.actor_avatar_color,
        actorPhotoVersion: row.actor_photo_version ? Number(row.actor_photo_version) : null,
        preview: String(row.preview || '').slice(0, 200),
        emoji: row.emoji,
        createdAt: row.created_at,
        unseen: !seenAt || new Date(row.created_at) > new Date(seenAt),
      })), ...canvasItems.rows.map((row) => mapCanvasItem(row, seenAt))]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit),
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
