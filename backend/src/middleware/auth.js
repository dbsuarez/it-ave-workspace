const { query } = require('../db');
const { viewAsRefusal } = require('../viewAs');

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
        'SELECT token_version FROM users WHERE id = $1 AND deactivated_at IS NULL',
        [user.userId]
      );
      if (result.rows.length === 0
        || Number(result.rows[0].token_version || 0) !== Number(user.tokenVersion || 0)) {
        return res.status(403).json({ error: 'Session expired; sign in again' });
      }
      if (user.viewAs) {
        // an Owner looking through someone's eyes: read-only, nothing private, and only while they are still an Owner
        const refusal = viewAsRefusal(req.method, req.originalUrl);
        if (refusal) return res.status(403).json({ error: refusal, viewAs: true });
        const owner = await query('SELECT 1 FROM users WHERE id = $1 AND is_superadmin = TRUE AND deactivated_at IS NULL', [user.viewAs]);
        if (!owner.rows.length) return res.status(403).json({ error: 'Session expired; sign in again' });
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
