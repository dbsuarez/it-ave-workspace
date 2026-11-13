const express = require('express');
const authenticateToken = require('../middleware/auth');
const { dispatch, listCommands } = require('../commands/dispatcher');
const { createAttemptLimiter, tooManyMessage } = require('../rateLimit');

const router = express.Router();
const executions = createAttemptLimiter({ windowMs: 60_000, max: 30 });
router.use(authenticateToken);

function sendError(res, error) {
  if (!error.status) console.error('Slash command error:', error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not run that command', code: error.code });
}

router.get('/', async (req, res) => {
  try {
    res.json({ commands: await listCommands({ userId: req.user.userId, channelId: req.query.channelId }) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/execute', async (req, res) => {
  try {
    const limit = executions.check(req.user.userId);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      return res.status(429).json({ error: tooManyMessage(limit.retryAfterSec), code: 'COMMAND_RATE_LIMITED' });
    }
    executions.record(req.user.userId);
    const body = req.body || {};
    res.json(await dispatch({ userId: req.user.userId, channelId: body.channelId, input: body.command, requestId: body.requestId }));
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
