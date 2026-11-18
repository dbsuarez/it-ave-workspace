const express = require('express');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { searchWorkspace, validateSearchTerm } = require('../searchService');

// Keep search visibility aligned with the channel membership authorization layer.
// Explicit bans override every grant, including legacy membership and Owner access.
router.get('/', authenticateToken, async (req, res) => {
  let searchTerm;
  try {
    searchTerm = validateSearchTerm(typeof req.query.q === 'string' ? req.query.q : '');
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  try {
    res.json(await searchWorkspace(query, req.user.userId, searchTerm));
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
