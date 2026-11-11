const express = require('express');
const router = express.Router();
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership } = require('../security');

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseTitle(value, maxLength) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title.length > 0 && title.length <= maxLength ? title : null;
}

function parseDueDate(value) {
  if (value === null || value === '' || value === undefined) return { valid: true, value: null };
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { valid: false, value: null };
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return {
    valid: !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value,
    value,
  };
}

async function getListChannel(listId) {
  const result = await query('SELECT channel_id FROM channel_lists WHERE id = $1', [listId]);
  if (result.rows.length === 0) {
    const err = new Error('List not found');
    err.status = 404;
    throw err;
  }
  return result.rows[0].channel_id;
}

async function ensureAssigneeMembership(channelId, assigneeId) {
  if (assigneeId === null) return;
  const result = await query(
    'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
    [channelId, assigneeId]
  );
  if (result.rows.length === 0) {
    const err = new Error('Assignee must be a member of this channel');
    err.status = 400;
    throw err;
  }
}

function handleError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    const channelId = req.query.channelId === undefined ? null : parseId(req.query.channelId);
    if (req.query.channelId !== undefined && channelId === null) {
      return res.status(400).json({ error: 'A valid channel ID is required' });
    }
    if (channelId !== null) {
      await ensureChannelMembership(query, req.user.userId, channelId);
    }

    const result = await query(
      `SELECT l.id, l.channel_id, l.title, l.created_at, l.updated_at,
              c.name AS channel_name,
              i.id AS item_id, i.title AS item_title, i.is_completed,
              i.assignee_id, assignee.username AS assignee_name,
              i.due_date, i.created_at AS item_created_at, i.updated_at AS item_updated_at
       FROM channel_lists l
       JOIN channels c ON c.id = l.channel_id
       JOIN channel_members member ON member.channel_id = l.channel_id
       LEFT JOIN channel_list_items i ON i.list_id = l.id
       LEFT JOIN users assignee ON assignee.id = i.assignee_id
       WHERE member.user_id = $1 AND ($2::int IS NULL OR l.channel_id = $2)
       ORDER BY l.created_at DESC, i.created_at ASC, i.id ASC`,
      [req.user.userId, channelId]
    );

    const listsById = new Map();
    for (const row of result.rows) {
      let list = listsById.get(row.id);
      if (!list) {
        list = {
          id: row.id,
          channelId: row.channel_id,
          channelName: row.channel_name,
          title: row.title,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          items: [],
        };
        listsById.set(row.id, list);
      }
      if (row.item_id !== null) {
        list.items.push({
          id: row.item_id,
          title: row.item_title,
          completed: row.is_completed,
          assigneeId: row.assignee_id,
          assigneeName: row.assignee_name,
          dueDate: row.due_date,
          createdAt: row.item_created_at,
          updatedAt: row.item_updated_at,
        });
      }
    }

    let members = [];
    if (channelId !== null) {
      const memberResult = await query(
        `SELECT u.id, u.username
         FROM channel_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = $1
         ORDER BY u.username`,
        [channelId]
      );
      members = memberResult.rows.map((member) => ({
        id: member.id,
        username: member.username,
      }));
    }

    res.json({ lists: Array.from(listsById.values()), members });
  } catch (err) {
    handleError(res, err, 'Get lists error');
  }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    const channelId = parseId(body.channelId);
    const title = parseTitle(body.title, 120);
    if (channelId === null) {
      return res.status(400).json({ error: 'A valid channel ID is required' });
    }
    if (!title) {
      return res.status(400).json({ error: 'List title must be between 1 and 120 characters' });
    }
    await ensureChannelMembership(query, req.user.userId, channelId);

    const result = await query(
      `INSERT INTO channel_lists (channel_id, title, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, channel_id, title, created_at, updated_at`,
      [channelId, title, req.user.userId]
    );
    const list = result.rows[0];
    res.status(201).json({
      list: {
        id: list.id,
        channelId: list.channel_id,
        title: list.title,
        createdAt: list.created_at,
        updatedAt: list.updated_at,
        items: [],
      },
    });
  } catch (err) {
    handleError(res, err, 'Create list error');
  }
});

router.patch('/:listId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    const channelId = await getListChannel(listId);
    await ensureChannelMembership(query, req.user.userId, channelId);

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    const title = parseTitle(body.title, 120);
    if (!title) {
      return res.status(400).json({ error: 'List title must be between 1 and 120 characters' });
    }
    const result = await query(
      `UPDATE channel_lists
       SET title = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, channel_id, title, updated_at`,
      [title, listId]
    );
    const list = result.rows[0];
    res.json({
      list: {
        id: list.id,
        channelId: list.channel_id,
        title: list.title,
        updatedAt: list.updated_at,
      },
    });
  } catch (err) {
    handleError(res, err, 'Update list error');
  }
});

router.delete('/:listId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    const channelId = await getListChannel(listId);
    await ensureChannelMembership(query, req.user.userId, channelId);
    await query('DELETE FROM channel_lists WHERE id = $1', [listId]);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Delete list error');
  }
});

router.post('/:listId/items', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    if (listId === null) return res.status(400).json({ error: 'A valid list ID is required' });
    const channelId = await getListChannel(listId);
    await ensureChannelMembership(query, req.user.userId, channelId);

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    const title = parseTitle(body.title, 200);
    const hasAssignee = body.assigneeId !== null && body.assigneeId !== ''
      && body.assigneeId !== undefined;
    const assigneeId = hasAssignee ? parseId(body.assigneeId) : null;
    const dueDate = parseDueDate(body.dueDate);
    if (!title) {
      return res.status(400).json({ error: 'Item title must be between 1 and 200 characters' });
    }
    if (hasAssignee && assigneeId === null) {
      return res.status(400).json({ error: 'A valid assignee ID is required' });
    }
    if (!dueDate.valid) return res.status(400).json({ error: 'Due date must be a valid YYYY-MM-DD date' });
    await ensureAssigneeMembership(channelId, assigneeId);

    const result = await query(
      `INSERT INTO channel_list_items (list_id, title, assignee_id, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, is_completed, assignee_id, due_date, created_at, updated_at`,
      [listId, title, assigneeId, dueDate.value, req.user.userId]
    );
    const item = result.rows[0];
    let assigneeName = null;
    if (assigneeId !== null) {
      const assignee = await query('SELECT username FROM users WHERE id = $1', [assigneeId]);
      assigneeName = assignee.rows[0].username;
    }
    res.status(201).json({
      item: {
        id: item.id,
        title: item.title,
        completed: item.is_completed,
        assigneeId: item.assignee_id,
        assigneeName,
        dueDate: item.due_date,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    });
  } catch (err) {
    handleError(res, err, 'Create list item error');
  }
});

router.patch('/:listId/items/:itemId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    const itemId = parseId(req.params.itemId);
    if (listId === null || itemId === null) {
      return res.status(400).json({ error: 'Valid list and item IDs are required' });
    }
    const channelId = await getListChannel(listId);
    await ensureChannelMembership(query, req.user.userId, channelId);

    const existing = await query(
      'SELECT id FROM channel_list_items WHERE id = $1 AND list_id = $2',
      [itemId, listId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'List item not found' });

    const values = [];
    const set = [];
    let assigneeId;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    if (Object.hasOwn(body, 'title')) {
      const title = parseTitle(body.title, 200);
      if (!title) {
        return res.status(400).json({ error: 'Item title must be between 1 and 200 characters' });
      }
      values.push(title);
      set.push(`title = $${values.length}`);
    }
    if (Object.hasOwn(body, 'completed')) {
      if (typeof body.completed !== 'boolean') {
        return res.status(400).json({ error: 'Completed must be true or false' });
      }
      values.push(body.completed);
      set.push(`is_completed = $${values.length}`);
    }
    if (Object.hasOwn(body, 'assigneeId')) {
      assigneeId = body.assigneeId === null || body.assigneeId === ''
        ? null : parseId(body.assigneeId);
      if (body.assigneeId !== null && body.assigneeId !== '' && assigneeId === null) {
        return res.status(400).json({ error: 'A valid assignee ID is required' });
      }
      await ensureAssigneeMembership(channelId, assigneeId);
      values.push(assigneeId);
      set.push(`assignee_id = $${values.length}`);
    }
    if (Object.hasOwn(body, 'dueDate')) {
      const dueDate = parseDueDate(body.dueDate);
      if (!dueDate.valid) return res.status(400).json({ error: 'Due date must be a valid YYYY-MM-DD date' });
      values.push(dueDate.value);
      set.push(`due_date = $${values.length}`);
    }
    if (set.length === 0) return res.status(400).json({ error: 'No item changes provided' });

    values.push(itemId, listId);
    const result = await query(
      `UPDATE channel_list_items
       SET ${set.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length - 1} AND list_id = $${values.length}
       RETURNING id, title, is_completed, assignee_id, due_date, updated_at`,
      values
    );
    const item = result.rows[0];
    if (!item) return res.status(404).json({ error: 'List item not found' });
    let assigneeName = null;
    if (item.assignee_id !== null) {
      const assignee = await query('SELECT username FROM users WHERE id = $1', [item.assignee_id]);
      assigneeName = assignee.rows[0].username;
    }
    res.json({
      item: {
        id: item.id,
        title: item.title,
        completed: item.is_completed,
        assigneeId: item.assignee_id,
        assigneeName,
        dueDate: item.due_date,
        updatedAt: item.updated_at,
      },
    });
  } catch (err) {
    handleError(res, err, 'Update list item error');
  }
});

router.delete('/:listId/items/:itemId', authenticateToken, async (req, res) => {
  try {
    const listId = parseId(req.params.listId);
    const itemId = parseId(req.params.itemId);
    if (listId === null || itemId === null) {
      return res.status(400).json({ error: 'Valid list and item IDs are required' });
    }
    const channelId = await getListChannel(listId);
    await ensureChannelMembership(query, req.user.userId, channelId);
    const result = await query(
      'DELETE FROM channel_list_items WHERE id = $1 AND list_id = $2',
      [itemId, listId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'List item not found' });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Delete list item error');
  }
});

module.exports = router;
