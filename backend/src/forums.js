// Department forums: one private forum channel per department, opened by the department's live membership
// (the department grant), moderated by the department head. Topics live in forum_topics; posts are ordinary messages
// carrying a topic_id. A forum is a channel, so access, bans, slow mode, archive, search and files all keep working.
const fail = (status, message) => Object.assign(new Error(message), { status });

const MAX_NAME = 50;

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// dept-<name> in the channel-name format (lowercase letters, numbers and hyphens, at most 50 characters).
function forumChannelName(departmentName, departmentId) {
  const base = slug(departmentName);
  const name = base ? `dept-${base}` : `dept-${departmentId}`;
  return name.slice(0, MAX_NAME).replace(/-+$/, '');
}

async function forumChannelIdFor(query, departmentId) {
  const found = await query('SELECT id FROM channels WHERE forum_department_id = $1', [departmentId]);
  return found.rows.length ? found.rows[0].id : null;
}

// The head, and only the head, holds the forum's moderator row (marked membership_source = 'dept-head' so a moderator
// someone else assigned is never touched). Safe to call whenever the head may have changed.
async function syncForumHead(query, departmentId) {
  const channelId = await forumChannelIdFor(query, departmentId);
  if (!channelId) return null;
  const head = (await query("SELECT d.head_id FROM departments d JOIN users u ON u.id = d.head_id WHERE d.id = $1 AND u.account_type = 'member' AND u.deactivated_at IS NULL", [departmentId])).rows[0];
  const headId = head ? head.head_id : null;
  await query("DELETE FROM channel_members WHERE channel_id = $1 AND membership_source = 'dept-head' AND user_id IS DISTINCT FROM $2", [channelId, headId]);
  if (headId) {
    await query(
      `INSERT INTO channel_members (channel_id, user_id, role, membership_source) VALUES ($1, $2, 'moderator', 'dept-head')
       ON CONFLICT (channel_id, user_id) DO UPDATE SET role = 'moderator', membership_source = 'dept-head'`,
      [channelId, headId]
    );
  }
  return channelId;
}

// dept-<name>, or dept-<name>-<id> when another channel already has that name.
async function pickForumName(query, department, excludeChannelId = null) {
  const name = forumChannelName(department.name, department.id);
  const clash = await query('SELECT 1 FROM channels WHERE name = $1 AND id IS DISTINCT FROM $2', [name, excludeChannelId]);
  if (!clash.rows.length) return name;
  const suffix = `-${department.id}`;
  return `${name.slice(0, MAX_NAME - suffix.length).replace(/-+$/, '')}${suffix}`;
}

// Creates the department's forum (private, slow mode 0, the department grant, the head as moderator) unless it exists.
async function ensureDepartmentForum(query, departmentId) {
  const existing = await forumChannelIdFor(query, departmentId);
  if (existing) return existing;
  const department = (await query('SELECT id, name FROM departments WHERE id = $1', [departmentId])).rows[0];
  if (!department) throw fail(404, 'Department not found');
  const name = await pickForumName(query, department);
  const created = await query(
    `INSERT INTO channels (name, topic, is_private, is_personal, available_to_all, kind, forum_department_id, slowmode_seconds, created_by)
     VALUES ($1, $2, TRUE, FALSE, FALSE, 'forum', $3, 0, NULL)
     ON CONFLICT (forum_department_id) WHERE forum_department_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [name, `Topics for ${department.name}`, department.id]
  );
  const channelId = created.rows.length ? created.rows[0].id : await forumChannelIdFor(query, departmentId);
  await query('INSERT INTO channel_department_grants (channel_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [channelId, departmentId]);
  await syncForumHead(query, departmentId);
  return channelId;
}

// Keeps the forum's name (and description) in step with the department's name.
async function renameForum(query, departmentId) {
  const channelId = await forumChannelIdFor(query, departmentId);
  if (!channelId) return null;
  const department = (await query('SELECT id, name FROM departments WHERE id = $1', [departmentId])).rows[0];
  if (!department) return channelId;
  await query('UPDATE channels SET name = $2, topic = $3 WHERE id = $1', [channelId, await pickForumName(query, department, channelId), `Topics for ${department.name}`]);
  return channelId;
}

// A deleted department's forum is archived (read-only, content kept) and detached; an Owner may delete it later.
async function archiveForumForDepartment(query, departmentId) {
  const archived = await query(
    'UPDATE channels SET archived_at = COALESCE(archived_at, NOW()), forum_department_id = NULL WHERE forum_department_id = $1 RETURNING id',
    [departmentId]
  );
  return archived.rows.length ? archived.rows[0].id : null;
}

// Creates the forum of every department that lacks one. Returns how many were created.
async function ensureAllForums(query) {
  const missing = await query(
    `SELECT d.id FROM departments d WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.forum_department_id = d.id) ORDER BY d.id`
  );
  for (const row of missing.rows) await ensureDepartmentForum(query, row.id);
  return missing.rows.length;
}

const TOPIC_COLUMNS = `t.id, t.channel_id, t.title, t.created_by, t.created_at, t.last_activity_at, t.pinned_at, t.locked_at, t.archived_at,
  u.username AS author_username,
  GREATEST((SELECT COUNT(*) FROM messages m WHERE m.topic_id = t.id) - 1, 0)::int AS reply_count`;

function serializeTopic(row) {
  return {
    id: Number(row.id),
    channelId: row.channel_id,
    title: row.title,
    authorId: row.created_by,
    authorUsername: row.author_username || null,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    pinnedAt: row.pinned_at,
    lockedAt: row.locked_at,
    archivedAt: row.archived_at,
    replyCount: row.reply_count,
  };
}

// One topic (404 when it does not exist), in the shape the API returns.
async function loadTopic(query, topicId) {
  const found = await query(`SELECT ${TOPIC_COLUMNS} FROM forum_topics t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = $1`, [topicId]);
  if (!found.rows.length) throw fail(404, 'Topic not found');
  return serializeTopic(found.rows[0]);
}

const TOPIC_PAGE = 50;

// Pinned topics first, then the most recently active; archived topics are listed apart. { topics, hasMore }.
async function listTopics(query, channelId, { archived = false, offset = 0 } = {}) {
  const rows = (await query(
    `SELECT ${TOPIC_COLUMNS} FROM forum_topics t LEFT JOIN users u ON u.id = t.created_by
     WHERE t.channel_id = $1 AND (t.archived_at IS NOT NULL) = $2
     ORDER BY (t.pinned_at IS NULL), t.pinned_at DESC, t.last_activity_at DESC, t.id DESC
     LIMIT $3 OFFSET $4`,
    [channelId, archived, TOPIC_PAGE + 1, offset]
  )).rows;
  return { topics: rows.slice(0, TOPIC_PAGE).map(serializeTopic), hasMore: rows.length > TOPIC_PAGE };
}

module.exports = { serializeTopic, loadTopic, listTopics, forumChannelName, forumChannelIdFor, ensureDepartmentForum, ensureAllForums, syncForumHead, renameForum, archiveForumForDepartment };
