const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const config = require('../config');
const authenticateToken = require('../middleware/auth');

// Register a new user
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
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

    // Auto-join default public channels
    const publicChannels = await query(
      'SELECT id FROM channels WHERE is_private = false'
    );
    for (const ch of publicChannels.rows) {
      await query(
        'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [ch.id, user.id]
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

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find user
    const result = await query(
      'SELECT id, username, email, password_hash, avatar_color, is_superadmin, token_version FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
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
      'SELECT id, username, email, avatar_color, is_superadmin, status, last_seen, created_at FROM users WHERE id = $1',
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

  if (username !== null && (username.length < 2 || username.length > 50)) {
    return res.status(400).json({ error: 'Username must be between 2 and 50 characters' });
  }
  if (avatarColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(avatarColor)) {
    return res.status(400).json({ error: 'Avatar color must be a six-digit hex color' });
  }
  if (username === null && avatarColor === undefined) {
    return res.status(400).json({ error: 'No profile changes were provided' });
  }

  try {
    const result = await query(
      `UPDATE users
       SET username = COALESCE($1, username),
           avatar_color = COALESCE($2, avatar_color)
       WHERE id = $3
       RETURNING id, username, email, avatar_color, is_superadmin, token_version`,
      [username, avatarColor ?? null, req.user.userId]
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
  if (newPassword !== undefined && (typeof newPassword !== 'string' || newPassword.length < 6)) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
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
    if (!await bcrypt.compare(currentPassword, current.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const passwordHash = newPassword === undefined
      ? null
      : await bcrypt.hash(newPassword, 10);
    const result = await query(
      `UPDATE users
       SET email = COALESCE($1, email),
           password_hash = COALESCE($2, password_hash),
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
