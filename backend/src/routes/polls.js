// Poll voting. Every request re-checks membership, guest status, archive and closed state (polls.js).
const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { ensureChannelMembership, ensureChannelModerator, ensureChannelNotArchived } = require('../security');
const polls = require('../polls');

const router = express.Router();
router.use(authenticateToken);

const parseId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);
function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}
// Clients refetch their own view when told a poll changed, so the event carries ids only (never votes or voters).
const announceChange = (req, poll) => req.io?.to(`channel_${poll.channel_id}`).emit('poll_updated', { pollId: Number(poll.id), channelId: poll.channel_id });

router.get('/:pollId', async (req, res) => {
  try {
    const pollId = parseId(req.params.pollId);
    if (!pollId) return res.status(400).json({ error: 'A valid poll is required' });
    const poll = await polls.loadPoll(query, pollId);
    await ensureChannelMembership(query, req.user.userId, poll.channel_id);
    res.json(await polls.serializePoll(query, pollId, req.user.userId));
  } catch (err) { sendError(res, err, 'Get poll error'); }
});

router.post('/:pollId/vote', async (req, res) => {
  try {
    const pollId = parseId(req.params.pollId);
    if (!pollId) return res.status(400).json({ error: 'A valid poll is required' });
    const poll = await polls.loadPoll(query, pollId);
    await polls.authorizeVoter(query, req.user.userId, poll);
    await polls.replaceVotes(req.user.userId, pollId, req.body ? req.body.optionIds : undefined);
    announceChange(req, poll);
    res.json(await polls.serializePoll(query, pollId, req.user.userId));
  } catch (err) { sendError(res, err, 'Vote error'); }
});

router.delete('/:pollId/vote', async (req, res) => {
  try {
    const pollId = parseId(req.params.pollId);
    if (!pollId) return res.status(400).json({ error: 'A valid poll is required' });
    const poll = await polls.loadPoll(query, pollId);
    await polls.authorizeVoter(query, req.user.userId, poll);
    await polls.replaceVotes(req.user.userId, pollId, null);
    announceChange(req, poll);
    res.json(await polls.serializePoll(query, pollId, req.user.userId));
  } catch (err) { sendError(res, err, 'Withdraw vote error'); }
});

// The creator or a channel moderator closes a poll.
router.post('/:pollId/close', async (req, res) => {
  try {
    const pollId = parseId(req.params.pollId);
    if (!pollId) return res.status(400).json({ error: 'A valid poll is required' });
    const poll = await polls.loadPoll(query, pollId);
    await ensureChannelMembership(query, req.user.userId, poll.channel_id);
    if (Number(poll.created_by) !== Number(req.user.userId)) await ensureChannelModerator(query, req.user.userId, poll.channel_id);
    await ensureChannelNotArchived(query, poll.channel_id);
    await polls.closePoll(query, pollId);
    announceChange(req, poll);
    res.json(await polls.serializePoll(query, pollId, req.user.userId));
  } catch (err) { sendError(res, err, 'Close poll error'); }
});

module.exports = router;
