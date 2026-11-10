const express = require('express');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');

// List notes for the current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, title, content, created_at, updated_at FROM notes WHERE user_id = $1 ORDER BY updated_at DESC',
      [req.user.userId]
    );
    res.json({
      notes: result.rows.map((n) => ({
        id: n.id,
        title: n.title,
        content: n.content,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
      })),
    });
  } catch (err) {
    console.error('List notes error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a note
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, content } = req.body;
    const trimmed = (title || 'Untitled').trim();
    const result = await query(
      `INSERT INTO notes (user_id, title, content)
       VALUES ($1, $2, $3)
       RETURNING id, title, content, created_at, updated_at`,
      [req.user.userId, trimmed.slice(0, 200), content || '']
    );
    const n = result.rows[0];
    res.status(201).json({
      note: {
        id: n.id,
        title: n.title,
        content: n.content,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
      },
    });
  } catch (err) {
    console.error('Create note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a note (read) — also bumps updated_at
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content } = req.body;
    const result = await query(
      `UPDATE notes
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           updated_at = NOW()
       WHERE id = $3 AND user_id = $4
       RETURNING id, title, content, updated_at`,
      [title || null, content ?? null, id, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    const n = result.rows[0];
    res.json({
      note: {
        id: n.id,
        title: n.title,
        content: n.content,
        updatedAt: n.updated_at,
      },
    });
  } catch (err) {
    console.error('Update note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a note
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      'DELETE FROM notes WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete note error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
