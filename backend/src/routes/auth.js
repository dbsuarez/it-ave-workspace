const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const config = require('../config');
const authenticateToken = require('../middleware/auth');
const { normalizeInviteCode, hashInviteCode, invitationProblem } = require('../guests');
const {
  loginFailuresByAccount,
  loginFailuresByAddress,
  registrationAttempts,
  passwordProblem,
  clientAddress,
  accountKey,
  rejectIfLimited,
} = require('../authLimits');

// Compared against when a username does not exist, so a wrong username takes as long
// to answer as a wrong password and cannot be told apart by timing.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Register a new user
router.post('/register', async (req, res) => {
  try {
    const address = clientAddress(req);
    if (rejectIfLimited(res, registrationAttempts.check(address))) return;
    registrationAttempts.record(address);

    const { username, email, password, inviteCode } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }
    if (typeof username !== 'string' || typeof email !== 'string') {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    const passwordIssue = passwordProblem(password, username);
    if (passwordIssue) {
      return res.status(400).json({ error: passwordIssue });
    }

    // Invitations: required when sign-up is invitation-only, optional otherwise.
    let invitation = null;
    if (normalizeInviteCode(inviteCode)) {
      const found = await query(
        'SELECT * FROM invitations WHERE code_hash = $1',
        [hashInviteCode(inviteCode)]
      );
      const problem = invitationProblem(found.rows[0]);
      if (problem) return res.status(400).json({ error: problem });
      invitation = found.rows[0];
    } else {
      const settings = await query('SELECT registration_mode FROM moderation_settings WHERE id = 1');
      if (settings.rows[0]?.registration_mode === 'invite') {
        return res.status(403).json({ error: 'Sign-up is by invitation only. Enter your invitation code.' });
      }
    }

    // Check if user already exists
    const existingUser = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const result = await query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, avatar_color, is_superadmin, token_version, created_at`,
      [username, email, passwordHash]
    );

    const user = result.rows[0];
    const accountType = invitation?.account_type === 'guest' ? 'guest' : 'member';

    if (invitation) {
      // Claim the invitation; a concurrent sign-up with the same code loses here.
      const claimed = await query(
        `UPDATE invitations SET used_at = NOW(), used_by = $1
         WHERE id = $2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
         RETURNING id`,
        [user.id, invitation.id]
      );
      if (!claimed.rows.length) {
        await query('DELETE FROM users WHERE id = $1', [user.id]);
        return res.status(400).json({ error: 'This invitation has already been used' });
      }
      if (accountType === 'guest') {
        await query("UPDATE users SET account_type = 'guest' WHERE id = $1", [user.id]);
      }
    }

    // Members join every public channel; guests only the channels they were invited to.
    const joinIds = new Set((invitation?.channel_ids || []).map(Number));
    if (accountType === 'member') {
      const publicChannels = await query(
        'SELECT id FROM channels WHERE is_private = false'
      );
      publicChannels.rows.forEach((ch) => joinIds.add(Number(ch.id)));
    }
    for (const channelId of joinIds) {
      await query(
        `INSERT INTO channel_members (channel_id, user_id)
         SELECT c.id, $2 FROM channels c WHERE c.id = $1
         ON CONFLICT DO NOTHING`,
        [channelId, user.id]
      );
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username, tokenVersion: user.token_version },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN }
    );

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatarColor: user.avatar_color,
        isSuperadmin: user.is_superadmin,
        accountType,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Slow down password guessing: failures are counted per address+account and per address.
    const address = clientAddress(req);
    const accountId = accountKey(req, username);
    if (rejectIfLimited(res, loginFailuresByAccount.check(accountId), loginFailuresByAddress.check(address))) {
      return;
    }
    const noteLoginFailure = () => {
      loginFailuresByAccount.record(accountId);
      loginFailuresByAddress.record(address);
    };

    // Find user
    const result = await query(
      'SELECT id, username, email, password_hash, avatar_color, is_superadmin, token_version, must_change_password, deactivated_at FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      noteLoginFailure();
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      noteLoginFailure();
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    loginFailuresByAccount.reset(accountId);
    if (user.deactivated_at) {
      return res.status(403).json({ error: 'This account has been deactivated. Ask HR if you think this is a mistake.' });
    }

    // Update last seen
    await query(
      'UPDATE users SET last_seen = NOW() WHERE id = $1',
      [user.id]
    );

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username, tokenVersion: user.token_version },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatarColor: user.avatar_color,
        isSuperadmin: user.is_superadmin,
        mustChangePassword: Boolean(user.must_change_password),
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Get current user profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, username, email, avatar_color, is_superadmin, status, last_seen, created_at, job_title, photo_file, photo_updated_at, must_change_password FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatarColor: user.avatar_color,
        isSuperadmin: user.is_superadmin,
        status: user.status,
        lastSeen: user.last_seen,
        createdAt: user.created_at,
        jobTitle: user.job_title || '',
        mustChangePassword: Boolean(user.must_change_password),
        photoVersion: user.photo_file && user.photo_updated_at ? new Date(user.photo_updated_at).getTime() : null,
      },
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/me', authenticateToken, async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : null;
  const avatarColor = req.body.avatarColor;
  const jobTitle = typeof req.body.jobTitle === 'string' ? req.body.jobTitle.trim() : null;

  if (jobTitle !== null && jobTitle.length > 100) {
    return res.status(400).json({ error: 'Job title can be at most 100 characters' });
  }
  if (username !== null && (username.length < 2 || username.length > 50)) {
    return res.status(400).json({ error: 'Username must be between 2 and 50 characters' });
  }
  if (avatarColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(avatarColor)) {
    return res.status(400).json({ error: 'Avatar color must be a six-digit hex color' });
  }
  if (username === null && avatarColor === undefined && jobTitle === null) {
    return res.status(400).json({ error: 'No profile changes were provided' });
  }

  try {
    const result = await query(
      `UPDATE users
       SET username = COALESCE($1, username),
           avatar_color = COALESCE($2, avatar_color),
           job_title = COALESCE($4, job_title)
       WHERE id = $3
       RETURNING id, username, email, avatar_color, is_superadmin, token_version, job_title`,
      [username, avatarColor ?? null, req.user.userId, jobTitle]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const token = jwt.sign(
      { userId: user.id, username: user.username, tokenVersion: user.token_version },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN }
    );
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatarColor: user.avatar_color,
        isSuperadmin: user.is_superadmin,
        jobTitle: user.job_title || '',
      },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username is already in use' });
    }
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Could not update profile' });
  }
});

router.put('/me/account', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : null;

  if (!currentPassword) {
    return res.status(400).json({ error: 'Current password is required' });
  }
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  const newPasswordIssue = newPassword === undefined ? null : passwordProblem(newPassword);
  if (newPasswordIssue) {
    return res.status(400).json({ error: newPasswordIssue.replace(/^Password/, 'New password') });
  }
  if (email === null && newPassword === undefined) {
    return res.status(400).json({ error: 'No account changes were provided' });
  }

  try {
    const current = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    // A stolen session token must not be usable to guess the current password.
    const guessKey = `account:${req.user.userId}`;
    if (rejectIfLimited(res, loginFailuresByAccount.check(guessKey))) return;
    if (typeof currentPassword !== 'string'
      || !await bcrypt.compare(currentPassword, current.rows[0].password_hash)) {
      loginFailuresByAccount.record(guessKey);
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    loginFailuresByAccount.reset(guessKey);

    const passwordHash = newPassword === undefined
      ? null
      : await bcrypt.hash(newPassword, 10);
    const result = await query(
      `UPDATE users
       SET email = COALESCE($1, email),
           password_hash = COALESCE($2, password_hash),
           must_change_password = CASE WHEN $2::text IS NULL THEN must_change_password ELSE false END,
           token_version = token_version + $3
       WHERE id = $4
       RETURNING id, username, email, avatar_color, is_superadmin, token_version`,
      [email, passwordHash, passwordHash ? 1 : 0, req.user.userId]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { userId: user.id, username: user.username, tokenVersion: user.token_version },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN }
    );
    if (passwordHash && req.io) {
      req.io.in(`user_${user.id}`).disconnectSockets(true);
    }
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatarColor: user.avatar_color,
        isSuperadmin: user.is_superadmin,
      },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email is already in use' });
    }
    console.error('Update account error:', err);
    res.status(500).json({ error: 'Could not update account' });
  }
});

module.exports = router;
