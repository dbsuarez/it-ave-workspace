const { ensureGuestCanReach } = require('./guests');

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
    `SELECT 1 FROM channels c
     CROSS JOIN users u
     WHERE c.id = $1 AND u.id = $2
       AND (u.is_superadmin = TRUE OR EXISTS (
         SELECT 1 FROM channel_members cm
         WHERE cm.channel_id = $1 AND cm.user_id = u.id
       ))`,
    [channelId, userId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Access denied');
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
  const result = await query(
    `SELECT 1
     FROM users u
     WHERE u.id = $2 AND EXISTS (SELECT 1 FROM channels WHERE id = $1) AND (
       u.is_superadmin = TRUE OR EXISTS (
         SELECT 1 FROM channel_members cm
         WHERE cm.channel_id = $1 AND cm.user_id = u.id AND cm.role = 'moderator'
       )
     )`,
    [channelId, userId]
  );
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

async function ensureCanPostToChannel(query, userId, channelId) {
  await ensureChannelMembership(query, userId, channelId);
  await ensureNotTimedOut(query, userId, channelId);
  const account = await query('SELECT is_superadmin FROM users WHERE id = $1', [userId]);
  if (account.rows[0]?.is_superadmin) return;

  const channel = await query(
    `SELECT c.slowmode_seconds, cm.last_message_at
     FROM channels c
     LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
     WHERE c.id = $1`,
    [channelId, userId]
  );
  if (!channel.rows.length) return;
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
     WHERE id = $1`,
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

const CANVAS_ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

async function isGuestAccount(query, userId) {
  const result = await query('SELECT account_type FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.account_type === 'guest';
}

// The caller's role on a standalone canvas: 'owner', 'editor', 'viewer', or null for no access.
// Sources: ownership, a personal grant (canvas_collaborators), and a grant to a channel the user
// belongs to. Guests are read-only unless they were granted personally.
async function getStandaloneCanvasRole(query, userId, canvas) {
  if (canvasOwnerId(canvas) === Number(userId)) return 'owner';
  const personal = await query(
    'SELECT role FROM canvas_collaborators WHERE canvas_id = $1 AND user_id = $2',
    [canvas.id, userId]
  );
  const granted = await query(
    `SELECT g.role FROM canvas_channel_grants g
     JOIN channel_members cm ON cm.channel_id = g.channel_id
     WHERE g.canvas_id = $1 AND cm.user_id = $2`,
    [canvas.id, userId]
  );
  let channelRole = null;
  if (granted.rows.length > 0) {
    channelRole = granted.rows.some((row) => row.role === 'editor') ? 'editor' : 'viewer';
    if (channelRole === 'editor' && await isGuestAccount(query, userId)) channelRole = 'viewer';
  }
  const roles = [personal.rows[0]?.role, channelRole].filter(Boolean);
  if (roles.length === 0) return null;
  return roles.reduce((best, role) => (CANVAS_ROLE_RANK[role] > CANVAS_ROLE_RANK[best] ? role : best));
}

// Returns the canvas row when userId meets the access requirements.
// neededRole is 'viewer' (default) or 'editor'.
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
    // Guests may read channel and DM canvases but not change them.
    if (neededRole === 'editor' && await isGuestAccount(query, userId)) {
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
  if (neededRole === 'editor' && role === 'viewer') {
    const err = new Error('Viewer access only');
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
  ensureChannelModerator,
  ensureNotTimedOut,
  ensureCanPostToChannel,
  ensureDirectMessageAccess,
  ensureCanvasAccess,
  getCanvasById,
  canvasOwnerId,
  getStandaloneCanvasRole,
  ensureFileAccess,
  isExtensionAllowed,
  isMimeAllowed,
};
