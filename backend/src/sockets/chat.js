const jwt = require('jsonwebtoken');
const config = require('../config');
const {
  ensureChannelMembership,
  ensureNotTimedOut,
  ensureCanPostToChannel,
  ensureChannelPermission,
  ensureDirectMessageAccess,
} = require('../security');
const { findMentionedUsers } = require('../mentions');
const { roleHandle } = require('../roles');
const {
  insertChannelMessage, insertDirectMessage, parseAttachmentIds, ATTACHMENT_UNAVAILABLE,
} = require('../attachments');

// Record @mentions for a new channel message and push activity events to the
// people it concerns. Never throws: a notification problem must not fail a send.
async function notifyMessageActivity(io, query, messageData, parentAuthorId) {
  try {
    const channel = await query('SELECT name FROM channels WHERE id = $1', [messageData.channelId]);
    const recipients = await query(
      'SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id <> $2',
      [messageData.channelId, messageData.userId]
    );
    for (const recipient of recipients.rows) {
      io.to(`user_${recipient.user_id}`).emit('channel_activity', {
        channelId: messageData.channelId,
        channelName: channel.rows[0]?.name || '',
        messageId: messageData.id,
        userId: messageData.userId,
        username: messageData.username,
        preview: String(messageData.content || '').slice(0, 200),
        createdAt: messageData.createdAt,
      });
    }
    const base = {
      messageId: messageData.id,
      channelId: messageData.channelId,
      channelName: channel.rows[0]?.name || '',
      actorId: messageData.userId,
      actorUsername: messageData.username,
      actorAvatarColor: messageData.avatarColor,
      preview: String(messageData.content || '').slice(0, 200),
      emoji: null,
      createdAt: messageData.createdAt,
    };
    const notified = new Set();

    if (String(messageData.content || '').includes('@')) {
      const members = await query(
        `SELECT u.id, u.username FROM channel_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = $1`,
        [messageData.channelId]
      );
      const mentionedById = new Map();
      findMentionedUsers(messageData.content, members.rows)
        .forEach((user) => mentionedById.set(Number(user.id), user));

      const groups = await query('SELECT id, handle AS username FROM user_groups');
      const mentionedGroups = findMentionedUsers(messageData.content, groups.rows);
      if (mentionedGroups.length) {
        const groupMembers = await query(
          `SELECT DISTINCT ugm.user_id AS id
           FROM user_group_members ugm
           JOIN channel_members cm ON cm.user_id = ugm.user_id AND cm.channel_id = $2
           WHERE ugm.group_id = ANY($1::int[])`,
          [mentionedGroups.map((group) => group.id), messageData.channelId]
        );
        groupMembers.rows.forEach((user) => mentionedById.set(Number(user.id), user));
      }

      // @team-lead style mentions of a role reach everyone who holds it (and is in this channel)
      try {
        const roleRows = (await query("SELECT id, name, builtin_key FROM roles WHERE builtin_key IS DISTINCT FROM 'everyone' AND builtin_key IS DISTINCT FROM 'owner'")).rows
          .map((r) => ({ id: r.id, username: roleHandle(r.name), builtin_key: r.builtin_key }))
          .filter((r) => r.username);
        const mentionedRoles = findMentionedUsers(messageData.content, roleRows);
        if (mentionedRoles.length) {
          const holders = await query(
            `SELECT DISTINCT u.id FROM users u
             JOIN channel_members cm ON cm.user_id = u.id AND cm.channel_id = $2
             WHERE u.deactivated_at IS NULL
               AND (u.id IN (SELECT user_id FROM user_roles WHERE role_id = ANY($1::int[]))
                    OR ($3::boolean AND u.is_hr))`,
            [mentionedRoles.map((r) => r.id), messageData.channelId, mentionedRoles.some((r) => r.builtin_key === 'hr')]
          );
          holders.rows.forEach((user) => mentionedById.set(Number(user.id), user));
        }
      } catch (roleErr) {
        console.error('Role mention error:', roleErr);
      }

      const mentioned = [...mentionedById.values()]
        .filter((user) => Number(user.id) !== Number(messageData.userId));
      for (const user of mentioned) {
        await query(
          'INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [messageData.id, user.id]
        );
        notified.add(Number(user.id));
        io.to(`user_${user.id}`).emit('activity', { ...base, type: 'mention' });
      }
    }

    if (parentAuthorId && Number(parentAuthorId) !== Number(messageData.userId)
      && !notified.has(Number(parentAuthorId))) {
      io.to(`user_${parentAuthorId}`).emit('activity', { ...base, type: 'reply' });
    }
  } catch (err) {
    console.error('Message activity notification error:', err);
  }
}

const MAX_HUDDLE_PARTICIPANTS = 6;
const MAX_DIRECT_HUDDLE_PARTICIPANTS = 2;

// A huddle key is a channel id (number) or, for a call between two people, "dm:<low>-<high>".
function directHuddleKey(a, b) {
  return `dm:${Math.min(Number(a), Number(b))}-${Math.max(Number(a), Number(b))}`;
}

function parseDirectHuddleKey(key) {
  const match = /^dm:(\d+)-(\d+)$/.exec(String(key));
  return match ? [Number(match[1]), Number(match[2])] : null;
}

// Throws (with a status) unless this person may be in this huddle: a member of the channel, or one of the two
// people of a direct call who is allowed to reach the other.
async function authorizeHuddle(query, userId, key) {
  const pair = typeof key === 'string' ? parseDirectHuddleKey(key) : null;
  if (!pair) {
    await ensureChannelMembership(query, userId, key);
    return;
  }
  if (!pair.includes(Number(userId))) {
    const err = new Error('This call is not for you');
    err.status = 403;
    throw err;
  }
  await ensureDirectMessageAccess(query, userId, pair.find((id) => id !== Number(userId)));
}
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
  // The account this connection has claimed. Set before any await so two racing
  // `authenticate` events cannot both succeed as different people.
  let claimedUserId = null;
  // View as (an Owner looking through someone's eyes): a listen-only connection. It receives the channel rooms the person
  // is in, so what they see updates live, but it is never signed in as them: no presence, no personal room (their DMs and
  // notifications), and every action below refuses because currentUserId stays null.
  let watchUserId = null;
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
    const pair = typeof huddleChannelId === 'string' ? parseDirectHuddleKey(huddleChannelId) : null;
    if (pair && io.to) {
      // if they had not answered yet, stop their ringing
      io.to(`user_${pair.find((id) => id !== Number(currentUserId))}`).emit('huddle:invite-cancelled', { fromId: currentUserId });
    }
    huddleChannelId = null;
    socket.huddleChannelId = null;
    socket.data.huddleChannelId = null;
  };

  // Authenticate socket connection
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET);
      if (decoded.viewAs) {
        const { query: watchQuery } = require('../db');
        const owner = await watchQuery('SELECT 1 FROM users WHERE id = $1 AND is_superadmin = TRUE AND deactivated_at IS NULL', [decoded.viewAs]);
        const person = await watchQuery('SELECT token_version FROM users WHERE id = $1 AND deactivated_at IS NULL', [decoded.userId]);
        if (!owner.rows.length || !person.rows.length || Number(person.rows[0].token_version || 0) !== Number(decoded.tokenVersion || 0)) {
          socket.emit('auth_error', { error: 'Session expired; sign in again' });
          socket.disconnect();
          return;
        }
        watchUserId = decoded.userId;
        socket.data.watching = decoded.userId;
        socket.emit('authenticated', { userId: decoded.userId, username: decoded.username, viewAs: true });
        return;
      }

      // One account per connection. A second `authenticate` may repeat the same account
      // but can never switch to another one, which would keep the first account's rooms.
      if (claimedUserId !== null && Number(decoded.userId) !== Number(claimedUserId)) {
        socket.emit('auth_error', { error: 'This connection is already signed in as a different account' });
        socket.disconnect();
        return;
      }
      claimedUserId = decoded.userId;

      const { query } = require('../db');
      const account = await query(
        'SELECT token_version FROM users WHERE id = $1 AND deactivated_at IS NULL',
        [decoded.userId]
      );
      if (account.rows.length === 0
        || Number(account.rows[0].token_version || 0) !== Number(decoded.tokenVersion || 0)) {
        socket.emit('auth_error', { error: 'Session expired; sign in again' });
        socket.disconnect();
        return;
      }

      currentUserId = decoded.userId;
      socket.userId = currentUserId;
      socket.username = decoded.username;
      socket.data.userId = currentUserId;
      socket.data.username = decoded.username;

      // Mark the user online (presence)
      try {
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
  socket.on('join_channel', async (channelId) => {
    const actingUser = currentUserId || watchUserId; // a View as connection may listen to the person's channels
    if (!actingUser) return;
    try {
      const { query } = require('../db');
      await ensureChannelMembership(query, actingUser, channelId);
      socket.join(`channel_${channelId}`);
      socket.emit('joined_channel', { channelId });
    } catch (err) {
      socket.emit('channel_error', { channelId, error: err.message || 'Channel access denied' });
    }
  });

  socket.on('join_canvas', async (canvasId) => {
    if (!currentUserId) return;
    try {
      const { query } = require('../db');
      const { ensureCanvasAccess } = require('../security');
      await ensureCanvasAccess(query, currentUserId, canvasId, 'viewer');
      socket.join(`canvas:${canvasId}`);
      socket.emit('joined_canvas', { canvasId });
    } catch (err) {
      socket.emit('canvas_error', { canvasId, error: err.message || 'Canvas access denied' });
    }
  });

  socket.on('leave_canvas', (canvasId) => {
    if (!currentUserId) return;
    socket.leave(`canvas:${canvasId}`);
    socket.emit('left_canvas', { canvasId });
  });

  // Leave a channel room
  socket.on('leave_channel', (channelId) => {
    if (!currentUserId) return;
    socket.leave(`channel_${channelId}`);
    socket.emit('left_channel', { channelId });
  });

  // channelId: a channel to join, or { withUserId } to start (or answer) a direct call with one person.
  socket.on('huddle:join', async (target) => {
    if (!currentUserId) {
      socket.emit('huddle:error', { error: 'Authentication required' });
      return;
    }
    if (huddleJoining) {
      socket.emit('huddle:error', { error: 'A huddle join is already in progress' });
      return;
    }

    let parsedKey;
    let directOther = null;
    if (target && typeof target === 'object') {
      directOther = Number(target.withUserId);
      if (!Number.isSafeInteger(directOther) || directOther < 1 || directOther === Number(currentUserId)) {
        socket.emit('huddle:error', { error: 'A valid person is required' });
        return;
      }
      parsedKey = directHuddleKey(currentUserId, directOther);
    } else {
      parsedKey = Number(target);
      if (!Number.isSafeInteger(parsedKey) || parsedKey < 1) {
        socket.emit('huddle:error', { error: 'A valid channel is required' });
        return;
      }
    }

    huddleJoining = true;
    const joinGeneration = ++huddleJoinGeneration;
    try {
      await withHuddleJoinLock(parsedKey, async () => {
        if (!huddleJoining || joinGeneration !== huddleJoinGeneration) return;
        const { query } = require('../db');
        await authorizeHuddle(query, currentUserId, parsedKey);
        if (!huddleJoining || joinGeneration !== huddleJoinGeneration) return;

        if (huddleChannelId === parsedKey) {
          socket.emit('huddle:error', { error: 'You are already in this huddle' });
          return;
        }

        const room = `huddle_${parsedKey}`;
        const connectedPeers = await io.in(room).fetchSockets();
        if (!huddleJoining || joinGeneration !== huddleJoinGeneration) return;

        if (connectedPeers.some((peer) => Number(peer.data.userId) === Number(currentUserId))) {
          socket.emit('huddle:error', { error: 'You are already in this huddle from another session' });
          return;
        }
        const cap = directOther ? MAX_DIRECT_HUDDLE_PARTICIPANTS : MAX_HUDDLE_PARTICIPANTS;
        if (connectedPeers.length >= cap) {
          socket.emit('huddle:error', { error: directOther ? 'This call already has two people' : 'This huddle is full (maximum 6 participants)' });
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
        huddleChannelId = parsedKey;
        socket.huddleChannelId = parsedKey;
        socket.data.huddleChannelId = parsedKey;

        const participants = connectedPeers.map((peer) => ({
          peerId: peer.id,
          id: peer.data.userId,
          username: peer.data.username,
        }));

        socket.emit('huddle:joined', {
          channelId: parsedKey,
          direct: directOther ? { userId: directOther } : undefined,
          participants,
          iceServers: config.WEBRTC_ICE_SERVERS,
        });
        socket.to(room).emit('huddle:participant-joined', {
          peerId: socket.id,
          channelId: parsedKey,
          id: currentUserId,
          username: socket.username,
        });
        // the first person into a direct call rings the other one
        if (directOther && connectedPeers.length === 0 && io.to) {
          io.to(`user_${directOther}`).emit('huddle:invite', {
            from: { id: currentUserId, username: socket.username },
            key: parsedKey,
          });
        }
      });
    } catch (err) {
      if (joinGeneration !== huddleJoinGeneration) return;
      if (err.status !== 403 && err.status !== 404 && err.status !== 400) {
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
      await authorizeHuddle(query, currentUserId, channelId);
      await authorizeHuddle(query, target.userId, channelId);
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
      socket.emit('huddle:error', { error: typeof huddleChannelId === 'string' ? 'You can no longer reach this person' : 'Channel access is required to continue this huddle' });
      leaveHuddle();
    }
  });

  // Whether this participant's camera or screen share is on, relayed to the call.
  socket.on('huddle:media-state', ({ video } = {}) => {
    if (!currentUserId || !huddleChannelId) return;
    const mode = video === 'camera' || video === 'screen' ? video : null;
    socket.to(`huddle_${huddleChannelId}`).emit('huddle:media-state', { peerId: socket.id, video: mode });
  });

  socket.on('huddle:leave', leaveHuddle);

  // Send a message to a channel
  socket.on('send_message', async (data) => {
    if (!currentUserId) return;

    const { channelId, content, replyTo } = data;
    const clientMessageId = typeof data.clientMessageId === 'string'
      ? data.clientMessageId.slice(0, 100)
      : null;

    const attachmentRequest = parseAttachmentIds(data);
    if (!channelId || (!content && !attachmentRequest.ids.length)) {
      socket.emit('message_error', { error: 'Channel ID and content/attachment are required', clientMessageId });
      return;
    }

    try {
      const { query } = require('../db');
      await ensureCanPostToChannel(query, currentUserId, channelId);
      if (attachmentRequest.ids.length) {
        await ensureChannelPermission(query, currentUserId, channelId, 'attach_files', 'You cannot attach files in this channel');
      }

      let replyToMessage = null;
      let parentAuthorId = null;
      if (replyTo) {
        const parentResult = await query(
          `SELECT m.id, m.content, m.user_id, u.username
           FROM messages m
           JOIN users u ON u.id = m.user_id
           WHERE m.id = $1 AND m.channel_id = $2`,
          [replyTo, channelId]
        );
        if (parentResult.rows.length === 0) {
          socket.emit('message_error', { error: 'Reply target not found in this channel', clientMessageId });
          return;
        }
        const parent = parentResult.rows[0];
        parentAuthorId = parent.user_id;
        replyToMessage = {
          id: parent.id,
          username: parent.username,
          content: parent.content,
        };
      }

      if (!attachmentRequest.ok) {
        socket.emit('message_error', { error: ATTACHMENT_UNAVAILABLE, clientMessageId });
        return;
      }
      // The uploads are claimed and the message created in one statement (see attachments.js).
      const message = await insertChannelMessage(query, {
        channelId, userId: currentUserId, content, replyTo, attachmentIds: attachmentRequest.ids,
      });
      if (!message) {
        socket.emit('message_error', { error: ATTACHMENT_UNAVAILABLE, clientMessageId });
        return;
      }

      const userResult = await query(
        'SELECT username, avatar_color FROM users WHERE id = $1',
        [currentUserId]
      );
      const user = userResult.rows[0];

      const attachmentsResult = await query(
        `SELECT id, filename, original_name, size, mime_type, uploaded_by
         FROM files WHERE message_id = $1 ORDER BY id`,
        [message.id]
      );
      const attachments = attachmentsResult.rows.map((f) => ({
        id: f.id,
        filename: f.original_name,
        size: f.size,
        mimeType: f.mime_type,
        uploadedBy: f.uploaded_by,
      }));

      const messageData = {
        id: message.id,
        channelId: message.channel_id,
        userId: message.user_id,
        username: user.username,
        avatarColor: user.avatar_color,
        content: message.content,
        replyTo: message.reply_to,
        replyToMessage,
        createdAt: message.created_at,
        attachments,
        reactions: [],
        clientMessageId,
      };

      io.to(`channel_${channelId}`).emit('new_message', messageData);
      socket.emit('message_sent', { messageId: message.id, clientMessageId, message: messageData });
      await notifyMessageActivity(io, query, messageData, parentAuthorId);
    } catch (err) {
      console.error('Send message error:', err);
      socket.emit('message_error', { error: err.message || 'Failed to send message', clientMessageId });
    }
  });

  // Send a direct message
  socket.on('send_direct_message', async (data) => {
    if (!currentUserId) return;

    const { receiverId, content } = data;
    const clientMessageId = typeof data.clientMessageId === 'string'
      ? data.clientMessageId.slice(0, 100)
      : null;

    const attachmentRequest = parseAttachmentIds(data);
    if (!receiverId || (!content && !attachmentRequest.ids.length)) {
      socket.emit('message_error', { error: 'Receiver ID and content/attachment are required', clientMessageId });
      return;
    }

    try {
      const { query } = require('../db');
      await ensureDirectMessageAccess(query, currentUserId, receiverId);

      if (!attachmentRequest.ok) {
        socket.emit('message_error', { error: ATTACHMENT_UNAVAILABLE, clientMessageId });
        return;
      }
      const dm = await insertDirectMessage(query, {
        senderId: currentUserId, receiverId, content, attachmentIds: attachmentRequest.ids,
      });
      if (!dm) {
        socket.emit('message_error', { error: ATTACHMENT_UNAVAILABLE, clientMessageId });
        return;
      }

      const userResult = await query(
        'SELECT username, avatar_color FROM users WHERE id = $1',
        [currentUserId]
      );
      const user = userResult.rows[0];

      const attachmentsResult = await query(
        `SELECT id, filename, original_name, size, mime_type, uploaded_by
         FROM files WHERE dm_message_id = $1 ORDER BY id`,
        [dm.id]
      );
      const attachments = attachmentsResult.rows.map((f) => ({
        id: f.id,
        filename: f.original_name,
        size: f.size,
        mimeType: f.mime_type,
        uploadedBy: f.uploaded_by,
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
        clientMessageId,
      };

      io.to(`user_${receiverId}`).emit('new_direct_message', dmData);
      socket.emit('new_direct_message', dmData);
    } catch (err) {
      console.error('Send direct message error:', err);
      socket.emit('message_error', { error: err.message || 'Failed to send direct message' });
    }
  });

  // Send a message to a group conversation
  socket.on('send_group_message', async (data = {}) => {
    if (!currentUserId) return;
    const conversationId = Number(data.conversationId);
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    const clientMessageId = typeof data.clientMessageId === 'string'
      ? data.clientMessageId.slice(0, 100)
      : null;

    if (!Number.isSafeInteger(conversationId) || conversationId < 1 || !content) {
      socket.emit('message_error', { error: 'Conversation and content are required', clientMessageId });
      return;
    }
    if (content.length > 10000) {
      socket.emit('message_error', { error: 'Message is too long', clientMessageId });
      return;
    }

    try {
      const { query } = require('../db');
      const members = await query(
        'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
        [conversationId]
      );
      if (!members.rows.some((row) => Number(row.user_id) === Number(currentUserId))) {
        socket.emit('message_error', { error: 'Access denied', clientMessageId });
        return;
      }
      const senderAccount = await query('SELECT account_type FROM users WHERE id = $1', [currentUserId]);
      if (senderAccount.rows[0]?.account_type === 'guest') {
        socket.emit('message_error', { error: 'Guests cannot use group messages', clientMessageId });
        return;
      }

      const result = await query(
        `INSERT INTO conversation_messages (conversation_id, user_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, conversation_id, user_id, content, created_at`,
        [conversationId, currentUserId, content]
      );
      const userResult = await query(
        'SELECT username, avatar_color FROM users WHERE id = $1',
        [currentUserId]
      );
      const row = result.rows[0];
      const messageData = {
        id: row.id,
        conversationId: row.conversation_id,
        senderId: row.user_id,
        senderUsername: userResult.rows[0].username,
        senderAvatarColor: userResult.rows[0].avatar_color,
        content: row.content,
        createdAt: row.created_at,
        attachments: [],
        clientMessageId,
      };
      await query(
        'UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, currentUserId]
      );
      members.rows.forEach((member) => {
        io.to(`user_${member.user_id}`).emit('new_group_message', messageData);
      });
    } catch (err) {
      console.error('Send group message error:', err);
      socket.emit('message_error', { error: err.message || 'Failed to send message', clientMessageId });
    }
  });

  // Typing indicator
  socket.on('typing', async ({ channelId, isTyping }) => {
    if (!currentUserId) return;
    try {
      const { query } = require('../db');
      await ensureChannelMembership(query, currentUserId, channelId);
      await ensureNotTimedOut(query, currentUserId, channelId);
      socket.to(`channel_${channelId}`).emit('user_typing', {
        userId: currentUserId,
        channelId,
        isTyping,
      });
    } catch (err) {
      if (err.status !== 403) console.error('Typing auth check failed:', err);
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

module.exports.notifyMessageActivity = notifyMessageActivity;
