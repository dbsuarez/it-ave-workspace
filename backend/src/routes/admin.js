const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { passwordProblem } = require('../authLimits');
const authenticateToken = require('../middleware/auth');
const {
  newInviteCode, hashInviteCode, invitationProblem, normalizeInviteCode,
} = require('../guests');
const { invitationLookups, clientAddress, rejectIfLimited } = require('../authLimits');
const { refreshConversation } = require('./conversations');

// Workspace administration for Superadmins: members and guests, invitations,
// and whether sign-up is open or invitation-only.
const router = express.Router();

const ACCOUNT_TYPES = ['member', 'guest'];
const REGISTRATION_MODES = ['open', 'invite'];
const MAX_EXPIRY_HOURS = 24 * 30;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function requireSuperadmin(req) {
  const result = await query('SELECT is_superadmin FROM users WHERE id = $1', [req.user.userId]);
  if (!result.rows[0]?.is_superadmin) throw fail(403, 'Superadmin access required');
}

async function audit(actorId, action, targetUserId, details) {
  await query(
    `INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details)
     VALUES (NULL, $1, $2, $3, $4)`,
    [actorId, targetUserId, action, JSON.stringify(details || {})]
  );
}

// Public: lets the sign-up form show what an invitation code grants.
router.get('/invitations/lookup', async (req, res) => {
  try {
    const address = clientAddress(req);
    if (rejectIfLimited(res, invitationLookups.check(address))) return;
    invitationLookups.record(address);
    const code = normalizeInviteCode(req.query.code);
    if (!code) return res.status(400).json({ error: 'An invitation code is required' });
    const result = await query(
      'SELECT account_type, expires_at, revoked_at, used_at FROM invitations WHERE code_hash = $1',
      [hashInviteCode(code)]
    );
    const problem = invitationProblem(result.rows[0]);
    if (problem) return res.status(404).json({ error: problem });
    res.json({ accountType: result.rows[0].account_type, expiresAt: result.rows[0].expires_at });
  } catch (err) {
    sendError(res, err, 'Invitation lookup error');
  }
});

// Public: whether the sign-up form must ask for an invitation code.
router.get('/registration', async (req, res) => {
  try {
    const result = await query('SELECT registration_mode FROM moderation_settings WHERE id = 1');
    res.json({ mode: result.rows[0]?.registration_mode || 'open' });
  } catch (err) {
    sendError(res, err, 'Get registration mode error');
  }
});

router.use(authenticateToken);

router.put('/registration', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const mode = req.body?.mode;
    if (!REGISTRATION_MODES.includes(mode)) throw fail(400, 'Mode must be open or invite');
    await query('UPDATE moderation_settings SET registration_mode = $1 WHERE id = 1', [mode]);
    await audit(req.user.userId, 'registration_mode_changed', null, { mode });
    res.json({ mode });
  } catch (err) {
    sendError(res, err, 'Set registration mode error');
  }
});

// ---- Members and guests ----
router.get('/users', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const result = await query(
      `SELECT u.id, u.username, u.email, u.account_type, u.is_superadmin, u.status, u.created_at,
              (SELECT COUNT(*)::int FROM channel_members cm WHERE cm.user_id = u.id) AS channel_count,
              (SELECT COUNT(*)::int FROM channel_members cm WHERE cm.user_id = u.id AND cm.role = 'moderator') AS moderator_count
       FROM users u
       WHERE u.account_type <> 'bot'
       ORDER BY LOWER(u.username)`
    );
    res.json({
      users: result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        accountType: row.account_type,
        isSuperadmin: row.is_superadmin,
        status: row.status,
        channelCount: row.channel_count,
        moderatorChannelCount: row.moderator_count,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    sendError(res, err, 'List workspace users error');
  }
});

router.patch('/users/:userId', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const userId = parseId(req.params.userId);
    if (!userId) throw fail(400, 'A valid user ID is required');
    const { accountType, isSuperadmin } = req.body || {};
    if (accountType === undefined && isSuperadmin === undefined) {
      throw fail(400, 'Nothing to change');
    }
    if (accountType !== undefined && !ACCOUNT_TYPES.includes(accountType)) {
      throw fail(400, 'Account type must be member or guest');
    }
    if (isSuperadmin !== undefined && typeof isSuperadmin !== 'boolean') {
      throw fail(400, 'isSuperadmin must be true or false');
    }
    if (userId === Number(req.user.userId)) {
      throw fail(400, 'You cannot change your own role; ask another Superadmin');
    }

    const current = await query(
      'SELECT account_type, is_superadmin FROM users WHERE id = $1',
      [userId]
    );
    if (!current.rows.length) throw fail(404, 'User not found');
    const nextType = accountType ?? current.rows[0].account_type;
    const nextSuperadmin = isSuperadmin ?? current.rows[0].is_superadmin;
    if (nextType === 'guest' && nextSuperadmin) {
      throw fail(400, 'A guest cannot be a Superadmin');
    }

    let leftConversations = [];
    if (nextType === 'guest' && current.rows[0].account_type !== 'guest') {
      // A guest holds no moderator roles and is not part of group messages.
      await query("UPDATE channel_members SET role = 'member' WHERE user_id = $1", [userId]);
      const left = await query(
        'DELETE FROM conversation_members WHERE user_id = $1 RETURNING conversation_id',
        [userId]
      );
      leftConversations = left.rows.map((row) => row.conversation_id);
    }
    const updated = await query(
      `UPDATE users SET account_type = $1, is_superadmin = $2 WHERE id = $3
       RETURNING id, username, account_type, is_superadmin`,
      [nextType, nextSuperadmin, userId]
    );
    await audit(req.user.userId, 'account_role_changed', userId, {
      accountType: nextType, isSuperadmin: nextSuperadmin,
    });
    req.io?.to(`user_${userId}`).emit('account_updated', {
      accountType: nextType, isSuperadmin: nextSuperadmin,
    });
    for (const conversationId of leftConversations) {
      req.io?.to(`user_${userId}`).emit('conversation_removed', { conversationId });
      await refreshConversation(req.io, conversationId);
    }
    const row = updated.rows[0];
    res.json({
      user: { id: row.id, username: row.username, accountType: row.account_type, isSuperadmin: row.is_superadmin },
    });
  } catch (err) {
    sendError(res, err, 'Update workspace user error');
  }
});

// ---- Invitations ----
function serializeInvitation(row) {
  const problem = invitationProblem(row);
  return {
    id: row.id,
    accountType: row.account_type,
    note: row.note,
    channelIds: row.channel_ids || [],
    createdBy: row.created_by_username || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    usedBy: row.used_by_username || null,
    revokedAt: row.revoked_at,
    status: row.used_at ? 'used' : (row.revoked_at ? 'revoked' : (problem ? 'expired' : 'pending')),
  };
}

router.get('/invitations', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const result = await query(
      `SELECT i.*, creator.username AS created_by_username, used.username AS used_by_username
       FROM invitations i
       LEFT JOIN users creator ON creator.id = i.created_by
       LEFT JOIN users used ON used.id = i.used_by
       ORDER BY i.created_at DESC
       LIMIT 200`
    );
    res.json({ invitations: result.rows.map(serializeInvitation) });
  } catch (err) {
    sendError(res, err, 'List invitations error');
  }
});

// ---- Creating accounts directly ----
const MAX_NEW_ACCOUNTS = 100;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// no 0/O, 1/l/I: a temporary password gets read out and typed
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function temporaryPassword() {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

// POST /api/admin/users - create one or many accounts at once.
// { accounts: [{ username, email, password?, lastName?, firstName?, middleName? }], accountType, channelIds }
// A missing password is generated. Each person must replace it at their first sign-in.
// The passwords are returned once; only hashes are stored.
router.post('/users', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const { accounts, accountType = 'member', channelIds = [] } = req.body || {};
    if (!ACCOUNT_TYPES.includes(accountType)) throw fail(400, 'Account type must be member or guest');
    if (!Array.isArray(accounts) || accounts.length === 0) throw fail(400, 'Give at least one account');
    if (accounts.length > MAX_NEW_ACCOUNTS) throw fail(400, `At most ${MAX_NEW_ACCOUNTS} accounts at a time`);
    if (!Array.isArray(channelIds) || channelIds.some((id) => !parseId(id))) throw fail(400, 'channelIds must be a list of channel IDs');
    const extraChannels = [...new Set(channelIds.map(Number))];
    if (accountType === 'guest' && extraChannels.length === 0) throw fail(400, 'Choose at least one channel for a guest');
    if (extraChannels.length) {
      const found = await query('SELECT id FROM channels WHERE id = ANY($1::int[])', [extraChannels]);
      if (found.rows.length !== extraChannels.length) throw fail(404, 'One or more channels were not found');
    }
    const publicChannels = accountType === 'member'
      ? (await query('SELECT id FROM channels WHERE is_private = false')).rows.map((row) => Number(row.id)) : [];
    const joinIds = [...new Set([...publicChannels, ...extraChannels])];

    const created = [];
    const skipped = [];
    const seen = new Set();
    for (const entry of accounts) {
      const username = typeof entry?.username === 'string' ? entry.username.trim() : '';
      const email = typeof entry?.email === 'string' ? entry.email.trim() : '';
      const label = username || email || '(blank)';
      if (!username || username.length > 50 || /\s/.test(username)) { skipped.push({ username: label, reason: 'The username must be 1 to 50 characters with no spaces' }); continue; }
      if (!EMAIL_SHAPE.test(email) || email.length > 255) { skipped.push({ username, reason: 'The email address is not valid' }); continue; }
      const key = `${username.toLowerCase()}|${email.toLowerCase()}`;
      if (seen.has(username.toLowerCase()) || seen.has(email.toLowerCase())) { skipped.push({ username, reason: 'Listed twice' }); continue; }
      seen.add(username.toLowerCase()); seen.add(email.toLowerCase());
      let password = entry.password;
      if (password === undefined || password === null || password === '') password = temporaryPassword();
      const problem = passwordProblem(password, username);
      if (problem) { skipped.push({ username, reason: problem }); continue; }
      const names = {};
      let nameProblem = null;
      for (const [field, label] of [['lastName', 'Last name'], ['firstName', 'First name'], ['middleName', 'Middle name']]) {
        const value = entry[field] === undefined || entry[field] === null ? '' : entry[field];
        if (typeof value !== 'string' || value.trim().length > 100) nameProblem = `${label} can be at most 100 characters`;
        names[field] = typeof value === 'string' ? value.trim() : '';
      }
      if (nameProblem) { skipped.push({ username, reason: nameProblem }); continue; }
      const exists = await query('SELECT 1 FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $2', [username.toLowerCase(), email.toLowerCase()]);
      if (exists.rows.length) { skipped.push({ username, reason: 'That username or email already exists' }); continue; }
      const hash = await bcrypt.hash(password, 10);
      const inserted = await query(
        `INSERT INTO users (username, email, password_hash, account_type, must_change_password, last_name, first_name, middle_name)
         VALUES ($1, $2, $3, $4, true, $5, $6, $7) RETURNING id`,
        [username, email, hash, accountType, names.lastName, names.firstName, names.middleName]
      );
      const userId = inserted.rows[0].id;
      for (const channelId of joinIds) {
        await query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [channelId, userId]);
      }
      await audit(req.user.userId, 'user_created', userId, { accountType, key });
      created.push({ id: userId, username, email, password });
    }
    res.status(created.length ? 201 : 200).json({ created, skipped });
  } catch (err) {
    sendError(res, err, 'Create accounts error');
  }
});

// Creates an invitation. The code is returned once and only its hash is stored.
router.post('/invitations', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const { accountType = 'member', channelIds = [], expiresInHours = 72, note = '' } = req.body || {};
    if (!ACCOUNT_TYPES.includes(accountType)) throw fail(400, 'Account type must be member or guest');
    if (!Array.isArray(channelIds) || channelIds.some((id) => !parseId(id))) {
      throw fail(400, 'channelIds must be a list of channel IDs');
    }
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > MAX_EXPIRY_HOURS) {
      throw fail(400, `Expiry must be a whole number of hours from 1 to ${MAX_EXPIRY_HOURS}`);
    }
    if (typeof note !== 'string' || note.trim().length > 120) {
      throw fail(400, 'Note must be 120 characters or fewer');
    }
    const ids = [...new Set(channelIds.map(Number))];
    if (accountType === 'guest' && ids.length === 0) {
      throw fail(400, 'Choose at least one channel for a guest');
    }
    if (ids.length) {
      const channels = await query('SELECT id FROM channels WHERE id = ANY($1::int[])', [ids]);
      if (channels.rows.length !== ids.length) throw fail(404, 'One or more channels were not found');
    }

    const code = newInviteCode();
    const created = await query(
      `INSERT INTO invitations (code_hash, account_type, channel_ids, note, created_by, expires_at)
       VALUES ($1, $2, $3::int[], $4, $5, NOW() + ($6 || ' hours')::interval)
       RETURNING *`,
      [hashInviteCode(code), accountType, ids, note.trim(), req.user.userId, String(expiresInHours)]
    );
    await audit(req.user.userId, 'invitation_created', null, {
      invitationId: created.rows[0].id, accountType, channelIds: ids,
    });
    res.status(201).json({ code, invitation: serializeInvitation(created.rows[0]) });
  } catch (err) {
    sendError(res, err, 'Create invitation error');
  }
});

router.delete('/invitations/:id', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const id = parseId(req.params.id);
    if (!id) throw fail(400, 'A valid invitation ID is required');
    const revoked = await query(
      `UPDATE invitations SET revoked_at = NOW()
       WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
       RETURNING id`,
      [id]
    );
    if (!revoked.rows.length) throw fail(404, 'No pending invitation with that ID');
    await audit(req.user.userId, 'invitation_revoked', null, { invitationId: id });
    res.json({ revoked: true });
  } catch (err) {
    sendError(res, err, 'Revoke invitation error');
  }
});

module.exports = router;
