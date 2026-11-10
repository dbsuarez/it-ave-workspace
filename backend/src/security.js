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

  const hasAllowedMime = isMimeAllowed(file.mimetype || '');
  const hasAllowedExtension = isExtensionAllowed(file.originalname);

  if (!hasAllowedMime && !hasAllowedExtension) {
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
    'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
    [channelId, userId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
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
}

async function ensureFileAccess(query, userId, fileId) {
  const fileResult = await query(
    `SELECT id, message_id, dm_message_id, uploaded_by
     FROM files WHERE id = $1`,
    [fileId]
  );

  if (fileResult.rows.length === 0) {
    const err = new Error('File not found');
    err.status = 404;
    throw err;
  }

  const file = fileResult.rows[0];

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
  ensureDirectMessageAccess,
  ensureFileAccess,
  isExtensionAllowed,
  isMimeAllowed,
};
