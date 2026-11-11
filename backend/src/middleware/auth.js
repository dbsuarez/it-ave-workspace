const { query } = require('../db');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const jwt = require('jsonwebtoken');
  const config = require('../config');

  jwt.verify(token, config.JWT_SECRET, async (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    try {
      const result = await query(
        'SELECT token_version FROM users WHERE id = $1',
        [user.userId]
      );
      if (result.rows.length === 0
        || Number(result.rows[0].token_version || 0) !== Number(user.tokenVersion || 0)) {
        return res.status(403).json({ error: 'Session expired; sign in again' });
      }
      req.user = user;
      next();
    } catch (dbErr) {
      console.error('Authentication session check failed:', dbErr);
      res.status(500).json({ error: 'Could not verify session' });
    }
  });
};

module.exports = authenticateToken;
