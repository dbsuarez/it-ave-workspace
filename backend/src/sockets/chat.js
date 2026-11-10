const jwt = require('jsonwebtoken');
const config = require('../config');
const { ensureChannelMembership, ensureDirectMessageAccess } = require('../security');

const MAX_HUDDLE_PARTICIPANTS = 6;
const huddleJoinLocks = new Map();

async function withHuddleJoinLock(channelId, operation) {
  const previous = huddleJoinLocks.get(channelId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  huddleJoinLocks.set(channelId, current);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (huddleJoinLocks.get(channelId) === current) {
      huddleJoinLocks.delete(channelId);
    }
  }
}

// Socket.io handlers for real-time chat
module.exports = (io, socket) => {
  let currentUserId = null;
  let huddleChannelId = null;
  let huddleJoining = false;
  let huddleJoinGeneration = 0;

  const leaveHuddle = () => {
    huddleJoinGeneration += 1;
    huddleJoining = false;
    if (!huddleChannelId) return;
    const room = `huddle_${huddleChannelId}`;
    socket.to(room).emit('huddle:participant-left', { peerId: socket.id });
    socket.leave(room);
    huddleChannelId = null;
    socket.huddleChannelId = null;
    socket.data.huddleChannelId = null;
  };

  // Authenticate socket connection
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET);
      currentUserId = decoded.userId;
      socket.userId = currentUserId;
      socket.username = decoded.username;
      socket.data.userId = currentUserId;
      socket.data.username = decoded.username;

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

  socket.on('huddle:join', async (channelId) => {
    if (!currentUserId) {
      socket.emit('huddle:error', { error: 'Authentication required' });
      return;
    }
    if (huddleJoining) {
      socket.emit('huddle:error', { error: 'A huddle join is already in progress' });
      return;
    }

    const parsedChannelId = Number(channelId);
    if (!Number.isSafeInteger(parsedChannelId) || parsedChannelId < 1) {
      socket.emit('huddle:error', { error: 'A valid channel is required' });
      return;
    }

    huddleJoining = true;
    const joinGeneration = ++huddleJoinGeneration;
    try {
      await withHuddleJoinLock(parsedChannelId, async () => {
        if (!huddleJoining || joinGeneration !== huddleJoinGeneration) return;
        const { query } = require('../db');
        await ensureChannelMembership(query, currentUserId, parsedChannelId);
        if (!huddleJoining || joinGeneration !== huddleJoinGeneration) return;

        if (huddleChannelId === parsedChannelId) {
          socket.emit('huddle:error', { error: 'You are already in this huddle' });
          return;
        }

        const room = `huddle_${parsedChannelId}`;
        const connectedPeers = await io.in(room).fetchSockets();
        if (!huddleJoining || joinGeneration !== huddleJoinGeneration) return;

        if (connectedPeers.some((peer) => Number(peer.data.userId) === Number(currentUserId))) {
          socket.emit('huddle:error', { error: 'You are already in this huddle from another session' });
          return;
        }
        if (connectedPeers.length >= MAX_HUDDLE_PARTICIPANTS) {
          socket.emit('huddle:error', { error: 'This huddle is full (maximum 6 participants)' });
          return;
        }

        if (huddleChannelId) {
          const previousRoom = `huddle_${huddleChannelId}`;
          socket.to(previousRoom).emit('huddle:participant-left', { peerId: socket.id });
          socket.leave(previousRoom);
          huddleChannelId = null;
          socket.huddleChannelId = null;
          socket.data.huddleChannelId = null;
        }
        socket.join(room);
        huddleChannelId = parsedChannelId;
        socket.huddleChannelId = parsedChannelId;
        socket.data.huddleChannelId = parsedChannelId;

        const participants = connectedPeers.map((peer) => ({
          peerId: peer.id,
          id: peer.data.userId,
          username: peer.data.username,
        }));

        socket.emit('huddle:joined', {
          channelId: parsedChannelId,
          participants,
          iceServers: config.WEBRTC_ICE_SERVERS,
        });
        socket.to(room).emit('huddle:participant-joined', {
          peerId: socket.id,
          channelId: parsedChannelId,
          id: currentUserId,
          username: socket.username,
        });
      });
    } catch (err) {
      if (joinGeneration !== huddleJoinGeneration) return;
      if (err.status !== 403) {
        console.error('Huddle join authorization failed:', err);
      }
      socket.emit('huddle:error', { error: err.message || 'Unable to join huddle' });
    } finally {
      if (joinGeneration === huddleJoinGeneration) huddleJoining = false;
    }
  });

  socket.on('huddle:signal', async ({ to, signal } = {}) => {
    if (!currentUserId || !huddleChannelId) {
      socket.emit('huddle:error', { error: 'Join a channel huddle before signaling' });
      return;
    }

    const hasDescription = signal?.description
      && ['offer', 'answer'].includes(signal.description.type)
      && typeof signal.description.sdp === 'string';
    const hasCandidate = signal?.candidate
      && typeof signal.candidate.candidate === 'string';
    if (typeof to !== 'string' || (!hasDescription && !hasCandidate)) {
      socket.emit('huddle:error', { error: 'Invalid WebRTC signaling data' });
      return;
    }

    const target = io.sockets.sockets.get(to);
    if (!target || target.huddleChannelId !== huddleChannelId) {
      socket.emit('huddle:error', { error: 'Huddle participant is no longer available' });
      return;
    }

    try {
      const { query } = require('../db');
      const channelId = huddleChannelId;
      await ensureChannelMembership(query, currentUserId, channelId);
      await ensureChannelMembership(query, target.userId, channelId);
      if (huddleChannelId !== channelId || target.huddleChannelId !== channelId) return;

      target.emit('huddle:signal', {
        from: socket.id,
        id: currentUserId,
        username: socket.username,
        signal,
      });
    } catch (err) {
      if (err.status !== 403) {
        console.error('Huddle signaling authorization failed:', err);
      }
      socket.emit('huddle:error', { error: 'Channel access is required to continue this huddle' });
      leaveHuddle();
    }
  });

  socket.on('huddle:leave', leaveHuddle);

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
  socket.on('disconnecting', () => {
    leaveHuddle();
  });

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
