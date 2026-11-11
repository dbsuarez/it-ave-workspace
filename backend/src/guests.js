// Guest accounts: restricted members who only see the channels they were
// invited to and the people in those channels.
const crypto = require('crypto');

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

async function isGuest(query, userId) {
  const result = await query('SELECT account_type FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.account_type === 'guest';
}

async function ensureNotGuest(query, userId, message = 'Guest accounts cannot do this') {
  if (await isGuest(query, userId)) throw fail(403, message);
}

async function sharesChannel(query, userId, otherUserId) {
  const result = await query(
    `SELECT 1 FROM channel_members mine
     JOIN channel_members theirs ON theirs.channel_id = mine.channel_id
     WHERE mine.user_id = $1 AND theirs.user_id = $2
     LIMIT 1`,
    [userId, otherUserId]
  );
  return result.rows.length > 0;
}

// A guest (on either side) can only exchange direct messages with people who
// share at least one channel with them.
async function ensureGuestCanReach(query, userId, otherUserId) {
  const accounts = await query(
    'SELECT id, account_type FROM users WHERE id = ANY($1::int[])',
    [[Number(userId), Number(otherUserId)]]
  );
  if (!accounts.rows.some((row) => row.account_type === 'guest')) return;
  if (!(await sharesChannel(query, userId, otherUserId))) {
    throw fail(403, 'Guests can only message people in their channels');
  }
}

function newInviteCode() {
  // 12 URL-safe characters, grouped for reading aloud: xxxx-xxxx-xxxx
  const raw = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function normalizeInviteCode(code) {
  return typeof code === 'string' ? code.trim().toLowerCase() : '';
}

function hashInviteCode(code) {
  return crypto.createHash('sha256').update(normalizeInviteCode(code)).digest('hex');
}

// Why an invitation row cannot be used, or null when it is usable.
function invitationProblem(row, now = new Date()) {
  if (!row) return 'This invitation code is not valid';
  if (row.revoked_at) return 'This invitation was revoked';
  if (row.used_at) return 'This invitation has already been used';
  if (row.expires_at && new Date(row.expires_at) <= now) return 'This invitation has expired';
  return null;
}

module.exports = {
  isGuest,
  ensureNotGuest,
  sharesChannel,
  ensureGuestCanReach,
  newInviteCode,
  normalizeInviteCode,
  hashInviteCode,
  invitationProblem,
};
