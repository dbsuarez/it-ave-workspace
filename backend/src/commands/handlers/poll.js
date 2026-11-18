// /poll "Question?" "Option A" "Option B" ... [--multi] [--anonymous] [--closes 2h]
// Shared and immediate (no preview): a poll is low risk, and a retried request id never creates a second one.
const { createPoll, parseDuration, validateNewPoll } = require('../../polls');

async function poll(ctx, args, options) {
  const [question, ...choices] = args;
  validateNewPoll({ question, options: choices });
  const closesAt = options.closes ? new Date(Date.now() + parseDuration(options.closes)) : null;
  await createPoll(ctx.io, ctx.query, {
    userId: ctx.userId, channelId: ctx.channelId, question, options: choices,
    multiple: Boolean(options.multi), anonymous: Boolean(options.anonymous), closesAt,
  });
  return { visibility: 'private', kind: 'card', title: 'Poll posted', data: { message: 'Your poll is now in the channel.' }, actions: [] };
}

module.exports = { poll };
