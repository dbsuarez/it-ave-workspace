const { can, needsCheckSql } = require('./permissions');
const { ensureGuestCanReach } = require('./guests');
const { superadminMaySee } = require('./ownerChannelAccess');

const ALLOWED_EXTENSIONS = new Set([
  'txt', 'csv', 'json', 'xml', 'md', 'log', 'ini', 'cfg', 'yaml', 'yml',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg',
  'mp3', 'wav', 'ogg', 'm4a',
  'mp4', 'mov', 'avi', 'mkv', 'webm',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
  'js', 'ts', 'css', 'html', 'htm'
]);

const ALLOWED_MIME_PREFIXES = [
  'text/',
  'image/',
  'audio/',
  'video/',
  'application/pdf',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/gzip',
  'application/x-tar',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
];

function getFileExtension(filename = '') {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : '';
}

function isMimeAllowed(mimetype = '') {
  const mime = mimetype.toLowerCase();
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime === prefix || mime.startsWith(prefix));
}

function isExtensionAllowed(filename = '') {
  const ext = getFileExtension(filename);
  return ext ? ALLOWED_EXTENSIONS.has(ext) : false;
}

function getUploadValidationError(file, maxFileSizeMb = 25) {
  if (!file) {
    return 'No file uploaded';
  }

  if (!file.originalname || !file.originalname.trim()) {
    return 'File name is required';
  }

  const maxBytes = maxFileSizeMb * 1024 * 1024;
  if (file.size > maxBytes) {
    return `File exceeds the ${maxFileSizeMb}MB limit`;
  }

  // The client-supplied MIME type is only a claim, so the allow-listed extension decides.
  if (!isExtensionAllowed(file.originalname)) {
    return 'Unsupported file type';
  }

  return null;
}

async function ensureChannelMembership(query, userId, channelId) {
  if (!userId) {
    const err = new Error('Authentication required');
    err.status = 401;
    throw err;
  }

  if (!channelId) {
    const err = new Error('Channel ID is required');
    err.status = 400;
    throw err;
  }

  const result = await query(
    `SELECT 1, ${needsCheckSql('view_channel', '$1')} AS needs_check FROM channels c
     CROSS JOIN users u
     WHERE c.id = $1 AND u.id = $2
       AND ((c.is_personal = TRUE AND c.created_by = u.id) OR (c.is_personal = FALSE AND (${superadminMaySee('u', 'c')} OR EXISTS (
         SELECT 1 FROM channel_members cm
         WHERE cm.channel_id = $1 AND cm.user_id = u.id
       ) OR EXISTS (
         SELECT 1 FROM channel_overrides co
         WHERE co.channel_id = $1
           AND co.subject_type = 'department'
           AND co.subject_id = u.department_id
           AND 'view_channel' = ANY(co.allow)
       ) OR EXISTS (
         SELECT 1 FROM channel_department_grants cdg
         JOIN user_departments ud ON ud.department_id = cdg.department_id
         WHERE cdg.channel_id = $1 AND ud.user_id = u.id
       ) OR EXISTS (
         SELECT 1 FROM channel_direct_grants dg
         WHERE dg.channel_id = $1 AND dg.user_id = u.id
           AND (dg.expires_at IS NULL OR dg.expires_at > NOW())
       ))))
       AND u.deactivated_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM channel_bans b WHERE b.channel_id = $1 AND b.user_id = u.id)`,
    [channelId, userId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }
  // a channel setting (or an edited Everyone role) may take viewing away from this person
  if (result.rows[0].needs_check && !(await can(query, userId, 'view_channel', { channelId }))) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }
}

// The channel-level permission check for send_messages, attach_files and add_reactions: a no-op in channels with no
// setting for it (see needsCheckSql), otherwise the full check. Throws 403 with `message`.
async function ensureChannelPermission(query, userId, channelId, permission, message) {
  // Phase 3 boundary: a role can grant an action, never content access.
  // Always check current access even when Everyone grants the action.
  await ensureChannelMembership(query, userId, channelId);
  const flag = await query(`SELECT ${needsCheckSql(permission, '$1')} AS needs_check`, [channelId]);
  if (!flag.rows[0] || !flag.rows[0].needs_check) return;
  if (!(await can(query, userId, permission, { channelId }))) {
    const err = new Error(message || 'You do not have permission to do that in this channel');
    err.status = 403;
    throw err;
  }
}

async function ensureChannelModerator(query, userId, channelId) {
  if (!userId || !channelId) {
    const err = new Error('Channel ID is required');
    err.status = userId ? 400 : 401;
    throw err;
  }
  // A moderator capability is not a channel-content access grant. In particular,
  // channel bans and revoked/expired grants must apply even to Owners and moderators.
  await ensureChannelMembership(query, userId, channelId);
  const result = await query(
    `SELECT 1
     FROM users u
     JOIN channels c ON c.id = $1
     WHERE u.id = $2 AND (
       (c.is_personal = TRUE AND c.created_by = u.id) OR (c.is_personal = FALSE AND (u.is_superadmin = TRUE OR EXISTS (
         SELECT 1 FROM channel_members cm
         WHERE cm.channel_id = $1 AND cm.user_id = u.id AND cm.role = 'moderator'
       )))
     )`,
    [channelId, userId]
  );
  const channel = await query('SELECT is_personal FROM channels WHERE id = $1', [channelId]);
  if (result.rows.length === 0 && !channel.rows[0]?.is_personal
      && (await can(query, userId, 'manage_messages', { channelId }))) return; // a role grants it
  if (result.rows.length === 0) {
    const err = new Error('Channel moderator access required');
    err.status = 403;
    throw err;
  }
}

async function ensureNotTimedOut(query, userId, channelId) {
  const timeout = await query(
    `SELECT expires_at FROM channel_timeouts
     WHERE channel_id = $1 AND user_id = $2 AND expires_at > NOW()
     ORDER BY expires_at DESC LIMIT 1`,
    [channelId, userId]
  );
  if (timeout.rows.length) {
    const err = new Error(`You are timed out in this channel until ${new Date(timeout.rows[0].expires_at).toISOString()}`);
    err.status = 403;
    err.expiresAt = timeout.rows[0].expires_at;
    throw err;
  }
}

async function ensureChannelNotArchived(query, channelId) {
  const state = await query('SELECT archived_at FROM channels WHERE id = $1', [channelId]);
  if (state.rows[0]?.archived_at) {
    const error = new Error('This channel is archived and read-only');
    error.status = 409;
    throw error;
  }
}

async function ensureCanPostToChannel(query, userId, channelId) {
  await ensureChannelMembership(query, userId, channelId);
  const archiveState = await query('SELECT archived_at FROM channels WHERE id = $1', [channelId]);
  if (archiveState.rows[0]?.archived_at) {
    const err = new Error('This channel is archived and read-only');
    err.status = 409;
    throw err;
  }
  await ensureNotTimedOut(query, userId, channelId);
  const account = await query('SELECT is_superadmin FROM users WHERE id = $1', [userId]);
  if (account.rows[0]?.is_superadmin) return;

  const channel = await query(
    `SELECT c.slowmode_seconds, cm.last_message_at, ${needsCheckSql('send_messages', '$1')} AS needs_post_check
     FROM channels c
     LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
     WHERE c.id = $1`,
    [channelId, userId]
  );
  if (!channel.rows.length) return;
  if (channel.rows[0].needs_post_check && !(await can(query, userId, 'send_messages', { channelId }))) {
    const err = new Error('You cannot send messages in this channel');
    err.status = 403;
    throw err;
  }
  const { slowmode_seconds: seconds, last_message_at: lastMessageAt } = channel.rows[0];
  if (seconds > 0) {
    if (!lastMessageAt) {
      const membership = await query(
        'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
      );
      if (!membership.rows.length) return;
    }
    const update = await query(
      `UPDATE channel_members
       SET last_message_at = NOW()
       WHERE channel_id = $1 AND user_id = $2
         AND (last_message_at IS NULL OR last_message_at <= NOW() - ($3 * INTERVAL '1 second'))
       RETURNING last_message_at`,
      [channelId, userId, seconds]
    );
    if (!update.rows.length) {
      const remaining = Math.max(1, Math.ceil(seconds - (Date.now() - new Date(lastMessageAt).getTime()) / 1000));
      const err = new Error(`Slow mode is on. Try again in ${remaining} seconds.`);
      err.status = 429;
      err.retryAfterSeconds = remaining;
      throw err;
    }
  }
}

async function ensureDirectMessageAccess(query, userId, otherUserId) {
  if (!otherUserId) {
    const err = new Error('User ID is required');
    err.status = 400;
    throw err;
  }

  if (Number(otherUserId) === Number(userId)) {
    const err = new Error('Direct messages to yourself are not allowed');
    err.status = 400;
    throw err;
  }

  const userExists = await query('SELECT id FROM users WHERE id = $1', [otherUserId]);
  if (userExists.rows.length === 0) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  await ensureGuestCanReach(query, userId, otherUserId);
}

async function getCanvasById(query, canvasId) {
  const result = await query(
    `SELECT id, kind, channel_id, dm_user_low, dm_user_high, created_by, title, content, created_at, updated_at, revision, owner_id
     FROM canvases
     WHERE id = $1 AND deleted_at IS NULL`,
    [canvasId]
  );
  if (!result.rows[0]) {
    const err = new Error('Canvas not found');
    err.status = 404;
    throw err;
  }
  return result.rows[0];
}

// The owner of a standalone canvas. owner_id is the transferable owner; older rows fall back to
// the creator.
function canvasOwnerId(canvas) {
  const id = canvas.owner_id ?? canvas.created_by;
  return id === null || id === undefined ? null : Number(id);
}

// viewer reads; commenter reads and comments; editor also changes the page; owner also shares and deletes
const CANVAS_ROLE_RANK = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

async function isGuestAccount(query, userId) {
  const result = await query('SELECT account_type FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.account_type === 'guest';
}

// The caller's role on a standalone canvas: 'owner', 'editor', 'viewer', or null for no access.
// Sources: ownership, a personal grant (canvas_collaborators), and a grant to a channel the user
// belongs to. Guests are read-only unless they were granted personally.
async function getStandaloneCanvasRole(query, userId, canvas) {
  // The text of a Knowledge Base article follows the article's rules, not the Canvas sharing ones: people who manage the Knowledge Base
  // edit it, every member reads it once it is published, nobody else has access (a draft is for HR only).
  const article = (await query('SELECT published FROM kb_articles WHERE canvas_id = $1', [canvas.id])).rows[0];
  if (article) {
    if (await can(query, userId, 'manage_knowledge_base')) return 'editor';
    const account = (await query('SELECT account_type, deactivated_at FROM users WHERE id = $1', [userId])).rows[0];
    return article.published && account && account.account_type === 'member' && !account.deactivated_at ? 'viewer' : null;
  }
  if (canvasOwnerId(canvas) === Number(userId)) return 'owner';
  const personal = await query(
    'SELECT role FROM canvas_collaborators WHERE canvas_id = $1 AND user_id = $2',
    [canvas.id, userId]
  );
  // A standalone canvas shared to a channel inherits the channel's CURRENT access.
  // A stale channel_members row is not sufficient after a ban or policy revocation.
  const granted = await query(
    `SELECT g.role, g.channel_id FROM canvas_channel_grants g
     WHERE g.canvas_id = $1`,
    [canvas.id]
  );
  let channelRole = null;
  for (const grant of granted.rows) {
    try {
      await ensureChannelMembership(query, userId, grant.channel_id);
    } catch (err) {
      if (err.status === 403 || err.status === 404) continue;
      throw err; // fail closed on database errors rather than masking an outage
    }
    if (CANVAS_ROLE_RANK[grant.role] > (CANVAS_ROLE_RANK[channelRole] || 0)) channelRole = grant.role;
  }
  if (channelRole === 'editor' && await isGuestAccount(query, userId)) channelRole = 'viewer';
  const roles = [personal.rows[0]?.role, channelRole].filter(Boolean);
  if (roles.length === 0) return null;
  return roles.reduce((best, role) => (CANVAS_ROLE_RANK[role] > CANVAS_ROLE_RANK[best] ? role : best));
}

// Returns the canvas row when userId meets the access requirements.
// neededRole is 'viewer' (default), 'commenter' or 'editor'.
async function ensureCanvasAccess(query, userId, canvasId, neededRole = 'viewer') {
  if (!userId || !canvasId) {
    const err = new Error('Missing canvas information');
    err.status = userId ? 400 : 401;
    throw err;
  }
  const canvas = await getCanvasById(query, canvasId);
  if (canvas.kind === 'channel' || canvas.kind === 'dm') {
    if (canvas.kind === 'channel') {
      await ensureChannelMembership(query, userId, canvas.channel_id);
    } else if (Number(userId) !== Number(canvas.dm_user_low) && Number(userId) !== Number(canvas.dm_user_high)) {
      const err = new Error('Canvas not found');
      err.status = 404;
      throw err;
    }
    // Guests may read channel and DM canvases but not change or comment on them.
    if ((neededRole === 'editor' || neededRole === 'commenter') && await isGuestAccount(query, userId)) {
      const err = new Error('Guests have view-only access to canvases');
      err.status = 403;
      throw err;
    }
    return canvas;
  }
  const role = await getStandaloneCanvasRole(query, userId, canvas);
  if (!role) {
    const err = new Error('Canvas not found');
    err.status = 404;
    throw err;
  }
  if (CANVAS_ROLE_RANK[role] < (CANVAS_ROLE_RANK[neededRole] || 1)) {
    const err = new Error(neededRole === 'commenter' ? 'You can only read this canvas' : role === 'commenter' ? 'Comment access only' : 'Viewer access only');
    err.status = 403;
    throw err;
  }
  return canvas;
}

async function ensureFileAccess(query, userId, fileId) {
  const fileResult = await query(
    `SELECT id, message_id, dm_message_id, canvas_id, uploaded_by
     FROM files WHERE id = $1`,
    [fileId]
  );

  if (fileResult.rows.length === 0) {
    const err = new Error('File not found');
    err.status = 404;
    throw err;
  }

  const file = fileResult.rows[0];

  // An image inside a canvas can be read by anyone who can read that canvas.
  if (file.canvas_id) {
    await ensureCanvasAccess(query, userId, file.canvas_id, 'viewer');
    return;
  }

  if (file.message_id) {
    const messageResult = await query(
      'SELECT channel_id FROM messages WHERE id = $1',
      [file.message_id]
    );
    if (messageResult.rows.length === 0) {
      const err = new Error('Message not found');
      err.status = 404;
      throw err;
    }

    await ensureChannelMembership(query, userId, messageResult.rows[0].channel_id);
    return;
  }

  if (file.dm_message_id) {
    const dmResult = await query(
      'SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1',
      [file.dm_message_id]
    );
    if (dmResult.rows.length === 0) {
      const err = new Error('Direct message not found');
      err.status = 404;
      throw err;
    }

    const dm = dmResult.rows[0];
    if (Number(dm.sender_id) !== Number(userId) && Number(dm.receiver_id) !== Number(userId)) {
      const err = new Error('Access denied');
      err.status = 403;
      throw err;
    }
    return;
  }

  if (Number(file.uploaded_by) === Number(userId)) {
    return;
  }

  const err = new Error('Access denied');
  err.status = 403;
  throw err;
}

module.exports = {
  getUploadValidationError,
  ensureChannelMembership,
  ensureChannelPermission,
  ensureChannelModerator,
  ensureNotTimedOut,
  ensureCanPostToChannel,
  ensureChannelNotArchived,
  ensureDirectMessageAccess,
  ensureCanvasAccess,
  getCanvasById,
  canvasOwnerId,
  getStandaloneCanvasRole,
  ensureFileAccess,
  isExtensionAllowed,
  isMimeAllowed,
};
