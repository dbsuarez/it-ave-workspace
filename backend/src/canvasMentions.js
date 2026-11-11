// Notifications for people mentioned in a canvas (@name in its text or in a comment) and for replies to
// their comments. Each one is stored in canvas_mentions (it shows in the Activity feed) and pushed to the
// person's open app as a `canvas_activity` socket event.
const { ensureCanvasAccess } = require('./security');

const MENTION = /(?:^|[\s(])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/g;

// Code is not a mention: "`@name`" and fenced blocks are ignored.
function withoutCode(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

// Lower-case, unique usernames mentioned in a text.
function extractMentions(text) {
  const found = new Set();
  for (const match of withoutCode(text).matchAll(MENTION)) found.add(match[1].toLowerCase());
  return Array.from(found);
}

// Mentions in `after` that were not in `before`: editing a canvas never repeats an old notification.
function addedMentions(before, after) {
  const had = new Set(extractMentions(before));
  return extractMentions(after).filter((name) => !had.has(name));
}

// The line that holds the mention, as plain text, for the notification preview.
function snippetFor(text, username) {
  const wanted = `@${String(username).toLowerCase()}`;
  const line = withoutCode(text).split('\n').find((candidate) => candidate.toLowerCase().includes(wanted)) || '';
  return line.replace(/[#>*_~`[\]]|^\s*[-+]\s(\[[ xX]\]\s)?/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// Tell these users about something in this canvas. Only people who can read the canvas are told.
async function deliver({ query, io, canvas, actorId, userIds, source, snippet }) {
  const delivered = [];
  const actor = (await query('SELECT id, username, avatar_color FROM users WHERE id = $1', [actorId])).rows[0];
  for (const userId of new Set(userIds)) {
    if (Number(userId) === Number(actorId)) continue;
    try {
      await ensureCanvasAccess(query, userId, canvas.id, 'viewer');
    } catch (err) {
      continue; // no access to this canvas: nothing to tell them
    }
    const row = (await query(
      `INSERT INTO canvas_mentions (canvas_id, user_id, actor_id, source, snippet)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [canvas.id, userId, actorId, source, snippet]
    )).rows[0];
    delivered.push(userId);
    io?.to(`user_${userId}`).emit('canvas_activity', {
      type: 'canvas_mention',
      id: row.id,
      source,
      canvasId: canvas.id,
      canvasKind: canvas.kind,
      canvasTitle: canvas.title,
      channelId: canvas.channel_id || null,
      actorId: actor ? actor.id : null,
      actorUsername: actor ? actor.username : null,
      actorAvatarColor: actor ? actor.avatar_color : null,
      preview: snippet,
      createdAt: row.created_at,
    });
  }
  return delivered;
}

async function notifyMentions({ query, io, canvas, actorId, text, usernames, source, snippet }) {
  const names = usernames || extractMentions(text);
  if (!names.length) return [];
  const users = await query(
    "SELECT id, username FROM users WHERE LOWER(username) = ANY($1) AND account_type <> 'bot'",
    [names]
  );
  const delivered = [];
  for (const user of users.rows) {
    const preview = snippet !== undefined ? snippet : snippetFor(text, user.username);
    delivered.push(...await deliver({ query, io, canvas, actorId, userIds: [user.id], source, snippet: preview }));
  }
  return delivered;
}

module.exports = { extractMentions, addedMentions, snippetFor, deliver, notifyMentions };
