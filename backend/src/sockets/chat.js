const jwt = require('jsonwebtoken');
const config = require('../config');
const { ensureChannelMembership, ensureDirectMessageAccess } = require('../security');

// Socket.io handlers for real-time chat
module.exports = (io, socket) => {
  let currentUserId = null;

  // Authenticate socket connection
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET);
      currentUserId = decoded.userId;
      socket.userId = currentUserId;
      socket.username = decoded.username;

      // Mark the user online (presence)
      try {
        const { query } = require('../db');
        await query(
          'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
          ['online', currentUserId]
        );
      } catch (dbErr) {
        console.error('Presence update (connect) error:', dbErr);
      }

      // Join user's personal room for direct messages
      socket.join(`user_${currentUserId}`);

      socket.emit('authenticated', { userId: currentUserId, username: decoded.username });
      console.log(`User ${decoded.username} (${currentUserId}) connected`);
    } catch (err) {
      socket.emit('auth_error', { error: 'Invalid token' });
      socket.disconnect();
    }
  });

  // Join a channel room
  socket.on('join_channel', (channelId) => {
    if (!currentUserId) return;
    socket.join(`channel_${channelId}`);
    socket.emit('joined_channel', { channelId });
  });

  // Leave a channel room
  socket.on('leave_channel', (channelId) => {
    if (!currentUserId) return;
    socket.leave(`channel_${channelId}`);
    socket.emit('left_channel', { channelId });
  });

  // Send a message to a channel
  socket.on('send_message', async (data) => {
    if (!currentUserId) return;

    const { channelId, content, replyTo, attachmentId } = data;

    if (!channelId || (!content && !attachmentId)) {
      socket.emit('message_error', { error: 'Channel ID and content/attachment are required' });
      return;
    }

    try {
      const { query } = require('../db');
      await ensureChannelMembership(query, currentUserId, channelId);

      if (attachmentId) {
        const attachmentResult = await query(
          'SELECT id, uploaded_by FROM files WHERE id = $1',
          [attachmentId]
        );
        if (attachmentResult.rows.length === 0 || Number(attachmentResult.rows[0].uploaded_by) !== Number(currentUserId)) {
          socket.emit('message_error', { error: 'Attachment not found or not owned by you' });
          return;
        }
      }

      const result = await query(
        `INSERT INTO messages (channel_id, user_id, content, reply_to)
         VALUES ($1, $2, $3, $4)
         RETURNING id, channel_id, user_id, content, reply_to, created_at`,
        [channelId, currentUserId, content || '', replyTo || null]
      );

      const message = result.rows[0];

      if (attachmentId) {
        await query(
          'UPDATE files SET message_id = $1 WHERE id = $2 AND uploaded_by = $3',
          [message.id, attachmentId, currentUserId]
        );
      }

      const userResult = await query(
        'SELECT username, avatar_color FROM users WHERE id = $1',
        [currentUserId]
      );
      const user = userResult.rows[0];

      const attachmentsResult = await query(
        `SELECT id, filename, original_name, size, mime_type
         FROM files WHERE message_id = $1`,
        [message.id]
      );
      const attachments = attachmentsResult.rows.map((f) => ({
        id: f.id,
        filename: f.original_name,
        size: f.size,
        mimeType: f.mime_type,
      }));

      const messageData = {
        id: message.id,
        channelId: message.channel_id,
        userId: message.user_id,
        username: user.username,
        avatarColor: user.avatar_color,
        content: message.content,
        replyTo: message.reply_to,
        createdAt: message.created_at,
        attachments,
        reactions: [],
      };

      io.to(`channel_${channelId}`).emit('new_message', messageData);
      socket.emit('message_sent', { messageId: message.id });
    } catch (err) {
      console.error('Send message error:', err);
      socket.emit('message_error', { error: err.message || 'Failed to send message' });
    }
  });

  // Send a direct message
  socket.on('send_direct_message', async (data) => {
    if (!currentUserId) return;

    const { receiverId, content, attachmentId } = data;

    if (!receiverId || (!content && !attachmentId)) {
      socket.emit('message_error', { error: 'Receiver ID and content/attachment are required' });
      return;
    }

    try {
      const { query } = require('../db');
      await ensureDirectMessageAccess(query, currentUserId, receiverId);

      if (attachmentId) {
        const attachmentResult = await query(
          'SELECT id, uploaded_by FROM files WHERE id = $1',
          [attachmentId]
        );
        if (attachmentResult.rows.length === 0 || Number(attachmentResult.rows[0].uploaded_by) !== Number(currentUserId)) {
          socket.emit('message_error', { error: 'Attachment not found or not owned by you' });
          return;
        }
      }

      const result = await query(
        `INSERT INTO direct_messages (sender_id, receiver_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, sender_id, receiver_id, content, created_at`,
        [currentUserId, receiverId, content || '']
      );

      const dm = result.rows[0];

      if (attachmentId) {
        await query(
          'UPDATE files SET dm_message_id = $1 WHERE id = $2 AND uploaded_by = $3',
          [dm.id, attachmentId, currentUserId]
        );
      }

      const userResult = await query(
        'SELECT username, avatar_color FROM users WHERE id = $1',
        [currentUserId]
      );
      const user = userResult.rows[0];

      const attachmentsResult = await query(
        `SELECT id, filename, original_name, size, mime_type
         FROM files WHERE dm_message_id = $1`,
        [dm.id]
      );
      const attachments = attachmentsResult.rows.map((f) => ({
        id: f.id,
        filename: f.original_name,
        size: f.size,
        mimeType: f.mime_type,
      }));

      const dmData = {
        id: dm.id,
        senderId: dm.sender_id,
        receiverId: dm.receiver_id,
        content: dm.content,
        createdAt: dm.created_at,
        senderUsername: user.username,
        senderAvatarColor: user.avatar_color,
        attachments,
      };

      io.to(`user_${receiverId}`).emit('new_direct_message', dmData);
      socket.emit('new_direct_message', dmData);
    } catch (err) {
      console.error('Send direct message error:', err);
      socket.emit('message_error', { error: err.message || 'Failed to send direct message' });
    }
  });

  // Typing indicator
  socket.on('typing', async ({ channelId, isTyping }) => {
    if (!currentUserId) return;
    try {
      const { query } = require('../db');
      await ensureChannelMembership(query, currentUserId, channelId);
      socket.to(`channel_${channelId}`).emit('user_typing', {
        userId: currentUserId,
        channelId,
        isTyping,
      });
    } catch (err) {
      console.error('Typing auth check failed:', err);
    }
  });

  // Disconnect
  socket.on('disconnect', async () => {
    if (currentUserId) {
      console.log(`User ${currentUserId} disconnected`);
      try {
        const { query } = require('../db');
        await query(
          'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
          ['offline', currentUserId]
        );
      } catch (dbErr) {
        console.error('Presence update (disconnect) error:', dbErr);
      }
    }
  });
};
