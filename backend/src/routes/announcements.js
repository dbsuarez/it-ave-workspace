// Announcements from the "Post announcement" dialog: the same rules as the /announce command. Only an announcement channel takes
// them (Moderation > the channel > Announcement channel), only people with the Announce permission there may post, and the channel
// must be open. The dialog is the confirmation, so there is no second step.
const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership, ensureChannelNotArchived, ensureNotTimedOut } = require('../security');
const { can } = require('../permissions');
const { postChannelMessage } = require('../messageDelivery');

const router = express.Router();
router.use(authenticateToken);

const MAX_ANNOUNCEMENT = 2000; // the same limit as /announce
const fail = (status, message) => Object.assign(new Error(message), { status });

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

// POST { channelId, text } -> 201 { message }
router.post('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const channelId = /^\d+$/.test(String(req.body && req.body.channelId)) ? Number(req.body.channelId) : null;
    if (!channelId) throw fail(400, 'A channel is required');
    await ensureChannelMembership(query, userId, channelId);
    const channel = (await query('SELECT command_scope FROM channels WHERE id = $1', [channelId])).rows[0];
    if (!channel || channel.command_scope !== 'announcements') throw fail(403, 'Announcements can only be posted in an announcement channel');
    if (!(await can(query, userId, 'announce', { channelId }))) throw fail(403, 'You do not have permission to post announcements');
    const text = req.body && typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) throw fail(400, 'Write the announcement first');
    if (text.length > MAX_ANNOUNCEMENT) throw fail(400, `An announcement can be at most ${MAX_ANNOUNCEMENT} characters`);
    await ensureChannelNotArchived(query, channelId);
    await ensureNotTimedOut(query, userId, channelId);
    const message = await postChannelMessage(req.io, query, { userId, channelId, content: text, kind: 'announcement' });
    res.status(201).json({ message });
  } catch (err) { sendError(res, err, 'Post announcement error'); }
});

module.exports = router;
