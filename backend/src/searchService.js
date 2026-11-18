// One search for the whole workspace, shared by GET /api/search and the /search command so both always show exactly
// what the person is allowed to see (channel visibility, bans and the Owner private-channel switch are applied in
// channelVisibilitySql.js).
const { channelVisibleToUser } = require('./channelVisibilitySql');

const MIN_SEARCH_LENGTH = 2;
const MAX_SEARCH_LENGTH = 100;

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

// Returns the cleaned search text, or throws a 400.
function validateSearchTerm(value) {
  const term = typeof value === 'string' ? value.trim() : '';
  if (term.length < MIN_SEARCH_LENGTH) throw Object.assign(new Error('Search query must be at least 2 characters'), { status: 400 });
  if (term.length > MAX_SEARCH_LENGTH) throw Object.assign(new Error('Search query must be 100 characters or fewer'), { status: 400 });
  return term;
}

// -> { messages, directMessages, people, files }, at most 5 of each kind (the JSON GET /api/search returns).
async function searchWorkspace(query, userId, searchTerm) {
  const pattern = `%${escapeLike(searchTerm)}%`;
  const [messages, directMessages, people, files] = await Promise.all([
    query(
      `SELECT m.id, m.channel_id, c.name AS channel_name, m.content, m.created_at,
              u.username
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN users u ON u.id = m.user_id
       WHERE ${channelVisibleToUser('m.channel_id')}
         AND m.content ILIKE $2 ESCAPE '\\'
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 5`,
      [userId, pattern]
    ),
    query(
      `SELECT dm.id, dm.content, dm.created_at,
              CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END AS other_user_id,
              other_user.username AS other_username
       FROM direct_messages dm
       JOIN users other_user
         ON other_user.id = CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END
       WHERE (dm.sender_id = $1 OR dm.receiver_id = $1)
         AND dm.content ILIKE $2 ESCAPE '\\'
       ORDER BY dm.created_at DESC, dm.id DESC
       LIMIT 5`,
      [userId, pattern]
    ),
    query(
      `SELECT id, username
       FROM users
       WHERE id != $1 AND deactivated_at IS NULL AND username ILIKE $2 ESCAPE '\\'
       ORDER BY username
       LIMIT 5`,
      [userId, pattern]
    ),
    query(
      `SELECT f.id, f.original_name, f.uploaded_at, u.username AS uploader_username,
              c.id AS channel_id, c.name AS channel_name,
              dm.sender_id, dm.receiver_id,
              CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END AS other_user_id,
              other_user.username AS other_username
       FROM files f
       JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN messages m ON m.id = f.message_id
       LEFT JOIN channels c ON c.id = m.channel_id
       LEFT JOIN direct_messages dm ON dm.id = f.dm_message_id
       LEFT JOIN users other_user
         ON other_user.id = CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END
       WHERE f.original_name ILIKE $2 ESCAPE '\\'
         AND (
           (f.message_id IS NOT NULL AND ${channelVisibleToUser('m.channel_id')})
           OR (f.dm_message_id IS NOT NULL AND (dm.sender_id = $1 OR dm.receiver_id = $1))
           OR (f.message_id IS NULL AND f.dm_message_id IS NULL AND f.uploaded_by = $1)
         )
       ORDER BY f.uploaded_at DESC, f.id DESC
       LIMIT 5`,
      [userId, pattern]
    ),
  ]);

  return {
    messages: messages.rows.map((message) => ({
      id: message.id,
      channelId: message.channel_id,
      channelName: message.channel_name,
      username: message.username,
      content: message.content,
      createdAt: message.created_at,
    })),
    directMessages: directMessages.rows.map((message) => ({
      id: message.id,
      userId: message.other_user_id,
      username: message.other_username,
      content: message.content,
      createdAt: message.created_at,
    })),
    people: people.rows.map((person) => ({
      id: person.id,
      username: person.username,
    })),
    files: files.rows.map((file) => ({
      id: file.id,
      name: file.original_name,
      uploadedAt: file.uploaded_at,
      uploaderUsername: file.uploader_username,
      channelId: file.channel_id,
      channelName: file.channel_name,
      userId: file.other_user_id,
      username: file.other_username,
    })),
  };
}

module.exports = { searchWorkspace, validateSearchTerm, MIN_SEARCH_LENGTH, MAX_SEARCH_LENGTH };
