// Posts text messages on a user's behalf outside a live socket (used by the
// scheduled-message runner). Applies the same permission checks and emits the
// same events as the socket handlers in sockets/chat.js.
const { ensureCanPostToChannel, ensureDirectMessageAccess } = require('./security');
const { notifyMessageActivity } = require('./sockets/chat');

async function loadSender(query, userId) {
  const result = await query('SELECT username, avatar_color FROM users WHERE id = $1', [userId]);
  if (!result.rows.length) throw Object.assign(new Error('Sender no longer exists'), { status: 404 });
  return result.rows[0];
}

async function postChannelMessage(io, query, { userId, channelId, content }) {
  await ensureCanPostToChannel(query, userId, channelId);
  const sender = await loadSender(query, userId);
  const result = await query(
    `INSERT INTO messages (channel_id, user_id, content)
     VALUES ($1, $2, $3)
     RETURNING id, channel_id, user_id, content, reply_to, created_at`,
    [channelId, userId, content]
  );
  const message = result.rows[0];
  const messageData = {
    id: message.id,
    channelId: message.channel_id,
    userId: message.user_id,
    username: sender.username,
    avatarColor: sender.avatar_color,
    content: message.content,
    replyTo: null,
    replyToMessage: null,
    createdAt: message.created_at,
    attachments: [],
    reactions: [],
    clientMessageId: null,
  };
  io.to(`channel_${channelId}`).emit('new_message', messageData);
  await notifyMessageActivity(io, query, messageData, null);
  return messageData;
}

async function postDirectMessage(io, query, { userId, receiverId, content }) {
  await ensureDirectMessageAccess(query, userId, receiverId);
  const sender = await loadSender(query, userId);
  const result = await query(
    `INSERT INTO direct_messages (sender_id, receiver_id, content)
     VALUES ($1, $2, $3)
     RETURNING id, sender_id, receiver_id, content, created_at`,
    [userId, receiverId, content]
  );
  const dm = result.rows[0];
  const dmData = {
    id: dm.id,
    senderId: dm.sender_id,
    receiverId: dm.receiver_id,
    content: dm.content,
    createdAt: dm.created_at,
    senderUsername: sender.username,
    senderAvatarColor: sender.avatar_color,
    attachments: [],
    clientMessageId: null,
  };
  io.to(`user_${receiverId}`).emit('new_direct_message', dmData);
  io.to(`user_${userId}`).emit('new_direct_message', dmData);
  return dmData;
}

module.exports = { postChannelMessage, postDirectMessage };
