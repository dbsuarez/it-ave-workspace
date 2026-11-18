// /announce <text>: post an announcement in an announcement channel. Shared (everyone in the channel sees it), so the
// dispatcher shows a preview first and posts only when the person confirms.
const { postChannelMessage } = require('../../messageDelivery');
const { ensureCanPostToChannel } = require('../../security');

function announcementText(args) {
  const text = args.join(' ').trim();
  if (!text) throw Object.assign(new Error('Write the announcement after /announce, for example: /announce Office closed on Friday'), { status: 400 });
  return text;
}

async function preview(ctx, args) {
  const text = announcementText(args);
  await ensureCanPostToChannel(ctx.query, ctx.userId, ctx.channelId); // fail now, not after the preview, if posting is not possible
  const row = (await ctx.query(
    `SELECT c.name, (SELECT COUNT(*)::int FROM channel_members cm JOIN users u ON u.id = cm.user_id
                      WHERE cm.channel_id = c.id AND u.deactivated_at IS NULL) AS members
     FROM channels c WHERE c.id = $1`,
    [ctx.channelId]
  )).rows[0];
  return {
    title: 'Post announcement',
    message: `This posts to #${row.name}, visible to ${row.members} member${row.members === 1 ? '' : 's'}:\n\n${text}`,
    confirmLabel: 'Post announcement',
  };
}

async function announce(ctx, args) {
  const text = announcementText(args);
  await postChannelMessage(ctx.io, ctx.query, { userId: ctx.userId, channelId: ctx.channelId, content: text, kind: 'announcement' });
  return { visibility: 'private', kind: 'card', title: 'Announcement posted', data: { message: 'Your announcement is now visible in this channel.' }, actions: [] };
}

module.exports = { announce, preview };
