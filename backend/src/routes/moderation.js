const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { can } = require('../permissions');
const authenticateToken = require('../middleware/auth');
const config = require('../config');
const { ensureChannelMembership, ensureChannelModerator } = require('../security');

const router = express.Router();
router.use(authenticateToken);

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

// Workspace-wide moderation needs a role permission (today only Owners have them): manage_workspace for settings and
// slow mode, manage_channels for changing a channel's moderators.
async function requireWorkspacePermission(userId, permission = 'manage_workspace') {
  if (!(await can(query, userId, permission))) {
    const err = new Error('Superadmin access required');
    err.status = 403;
    throw err;
  }
}

async function audit(channelId, actorId, action, targetUserId = null, details = {}) {
  await query(
    `INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [channelId, actorId, targetUserId, action, JSON.stringify(details)]
  );
}

router.get('/access', async (req, res) => {
  try {
    const result = await query(
      `SELECT u.is_superadmin, u.is_hr, u.account_type, cm.channel_id
       FROM users u
       LEFT JOIN channel_members cm ON cm.user_id = u.id AND cm.role = 'moderator'
       WHERE u.id = $1`,
      [req.user.userId]
    );
    res.json({
      canManageRoles: await can(query, req.user.userId, 'manage_roles'),
      isSuperadmin: Boolean(result.rows[0]?.is_superadmin),
      isHr: Boolean(result.rows[0]?.is_hr),
      accountType: result.rows[0]?.account_type || 'member',
      moderatorChannelIds: result.rows.filter((row) => row.channel_id !== null).map((row) => row.channel_id),
    });
  } catch (err) {
    sendError(res, err, 'Get moderation access error');
  }
});

router.get('/audit', async (req, res) => {
  try {
    const channelId = req.query.channelId === undefined ? null : parseId(req.query.channelId);
    if (req.query.channelId !== undefined && !channelId) {
      return res.status(400).json({ error: 'A valid channel ID is required' });
    }
    if (channelId) await ensureChannelModerator(query, req.user.userId, channelId);
    else await requireWorkspacePermission(req.user.userId, 'view_audit_log');
    const limit = Number(req.query.limit || 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'Limit must be between 1 and 100' });
    }
    const result = await query(
      `SELECT l.id, l.channel_id, channel.name AS channel_name, actor.username AS actor_username,
              target.username AS target_username, l.action, l.details, l.created_at
       FROM moderation_audit_log l
       LEFT JOIN channels channel ON channel.id = l.channel_id
       LEFT JOIN users actor ON actor.id = l.actor_id
       LEFT JOIN users target ON target.id = l.target_user_id
       WHERE ($1::integer IS NULL OR l.channel_id = $1)
       ORDER BY l.created_at DESC LIMIT $2`,
      [channelId, limit]
    );
    res.json({
      entries: result.rows.map((entry) => ({
        id: entry.id, channelId: entry.channel_id, channelName: entry.channel_name,
        actorUsername: entry.actor_username, targetUsername: entry.target_username,
        action: entry.action, details: entry.details, createdAt: entry.created_at,
      })),
    });
  } catch (err) {
    sendError(res, err, 'Get moderation audit log error');
  }
});

router.get('/settings', async (req, res) => {
  try {
    await requireWorkspacePermission(req.user.userId, 'manage_workspace');
    const result = await query(
      'SELECT default_timeout_minutes, max_timeout_minutes FROM moderation_settings WHERE id = 1'
    );
    res.json({
      settings: {
        defaultTimeoutMinutes: result.rows[0].default_timeout_minutes,
        maxTimeoutMinutes: result.rows[0].max_timeout_minutes,
      },
    });
  } catch (err) {
    sendError(res, err, 'Get moderation settings error');
  }
});

router.put('/settings', async (req, res) => {
  try {
    await requireWorkspacePermission(req.user.userId, 'manage_workspace');
    const { defaultTimeoutMinutes, maxTimeoutMinutes } = req.body || {};
    if (!Number.isInteger(defaultTimeoutMinutes) || !Number.isInteger(maxTimeoutMinutes)
      || defaultTimeoutMinutes < 1 || maxTimeoutMinutes < 1 || maxTimeoutMinutes > 10080
      || defaultTimeoutMinutes > maxTimeoutMinutes) {
      return res.status(400).json({ error: 'Timeout settings must be whole minutes from 1 to 10080, with the default no greater than the maximum' });
    }
    const result = await query(
      `UPDATE moderation_settings
       SET default_timeout_minutes = $1, max_timeout_minutes = $2,
           updated_by = $3, updated_at = NOW()
       WHERE id = 1
       RETURNING default_timeout_minutes, max_timeout_minutes`,
      [defaultTimeoutMinutes, maxTimeoutMinutes, req.user.userId]
    );
    await audit(null, req.user.userId, 'settings_updated', null, result.rows[0]);
    res.json({
      settings: {
        defaultTimeoutMinutes: result.rows[0].default_timeout_minutes,
        maxTimeoutMinutes: result.rows[0].max_timeout_minutes,
      },
    });
  } catch (err) {
    sendError(res, err, 'Update moderation settings error');
  }
});

router.get('/channels/:channelId', async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    if (!channelId) return res.status(400).json({ error: 'A valid channel ID is required' });
    await ensureChannelModerator(query, req.user.userId, channelId);
    const [channel, members, timeouts, reports, auditLog] = await Promise.all([
      query('SELECT id, name, slowmode_seconds FROM channels WHERE id = $1', [channelId]),
      query(
        `SELECT u.id, u.username, cm.role
         FROM channel_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = $1 ORDER BY u.username`,
        [channelId]
      ),
      query(
        `SELECT t.id, t.user_id, u.username, t.reason, t.expires_at
         FROM channel_timeouts t JOIN users u ON u.id = t.user_id
         WHERE t.channel_id = $1 AND t.expires_at > NOW()
         ORDER BY t.expires_at DESC`,
        [channelId]
      ),
      query(
        `SELECT r.id, r.message_id, r.reporter_id, reporter.username AS reporter_username,
                target.username AS target_username, r.reason, r.status, r.created_at
         FROM message_reports r
         LEFT JOIN users reporter ON reporter.id = r.reporter_id
         JOIN messages m ON m.id = r.message_id
         JOIN users target ON target.id = m.user_id
         WHERE r.channel_id = $1 AND r.status = 'open'
         ORDER BY r.created_at ASC LIMIT 100`,
        [channelId]
      ),
      query(
        `SELECT l.id, l.actor_id, actor.username AS actor_username, l.target_user_id,
                target.username AS target_username, l.action, l.details, l.created_at
         FROM moderation_audit_log l
         LEFT JOIN users actor ON actor.id = l.actor_id
         LEFT JOIN users target ON target.id = l.target_user_id
         WHERE l.channel_id = $1 ORDER BY l.created_at DESC LIMIT 50`,
        [channelId]
      ),
    ]);
    if (!channel.rows.length) return res.status(404).json({ error: 'Channel not found' });
    res.json({
      channel: {
        id: channel.rows[0].id,
        name: channel.rows[0].name,
        slowmodeSeconds: channel.rows[0].slowmode_seconds,
      },
      members: members.rows.map((member) => ({
        id: member.id, username: member.username, role: member.role,
      })),
      timeouts: timeouts.rows.map((timeout) => ({
        id: timeout.id, userId: timeout.user_id, username: timeout.username,
        reason: timeout.reason, expiresAt: timeout.expires_at,
      })),
      reports: reports.rows.map((report) => ({
        id: report.id, messageId: report.message_id, reporterId: report.reporter_id,
        reporterUsername: report.reporter_username, targetUsername: report.target_username,
        reason: report.reason, createdAt: report.created_at,
      })),
      auditLog: auditLog.rows.map((entry) => ({
        id: entry.id, actorUsername: entry.actor_username, targetUsername: entry.target_username,
        action: entry.action, details: entry.details, createdAt: entry.created_at,
      })),
    });
  } catch (err) {
    sendError(res, err, 'Get channel moderation data error');
  }
});

router.put('/channels/:channelId/members/:userId', async (req, res) => {
  try {
    await requireWorkspacePermission(req.user.userId, 'manage_channels');
    const channelId = parseId(req.params.channelId);
    const userId = parseId(req.params.userId);
    const { role } = req.body || {};
    if (!channelId || !userId) return res.status(400).json({ error: 'Valid channel and user IDs are required' });
    if (!['member', 'moderator'].includes(role)) {
      return res.status(400).json({ error: 'Role must be member or moderator' });
    }
    const result = await query(
      `INSERT INTO channel_members (channel_id, user_id, role)
       SELECT c.id, u.id, $3 FROM channels c CROSS JOIN users u
       WHERE c.id = $1 AND u.id = $2
       ON CONFLICT (channel_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING user_id, role`,
      [channelId, userId, role]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    await audit(channelId, req.user.userId, 'member_role_changed', userId, { role });
    res.json({ userId: result.rows[0].user_id, role: result.rows[0].role });
  } catch (err) {
    sendError(res, err, 'Update channel role error');
  }
});

router.delete('/channels/:channelId/members/:userId', async (req, res) => {
  try {
    await requireWorkspacePermission(req.user.userId, 'manage_channels');
    const channelId = parseId(req.params.channelId);
    const userId = parseId(req.params.userId);
    if (!channelId || !userId) return res.status(400).json({ error: 'Valid channel and user IDs are required' });
    const result = await query(
      'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2 RETURNING user_id',
      [channelId, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Channel membership not found' });
    await audit(channelId, req.user.userId, 'member_removed', userId);
    if (req.io?.in) {
      req.io.in(`channel_${channelId}`).fetchSockets().then((sockets) => {
        sockets.filter((socket) => Number(socket.data.userId) === userId)
          .forEach((socket) => {
            socket.emit('channel_access_revoked', { channelId });
            socket.leave(`channel_${channelId}`);
          });
      }).catch((err) => console.error('Remove member from channel room error:', err));
    }
    res.json({ removed: true });
  } catch (err) {
    sendError(res, err, 'Remove channel member error');
  }
});

router.post('/channels/:channelId/timeouts/:userId', async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    const userId = parseId(req.params.userId);
    if (!channelId || !userId) return res.status(400).json({ error: 'Valid channel and user IDs are required' });
    await ensureChannelModerator(query, req.user.userId, channelId);
    const actor = await query('SELECT is_superadmin FROM users WHERE id = $1', [req.user.userId]);
    const target = await query(
      `SELECT u.is_superadmin,
              EXISTS (SELECT 1 FROM channel_members cm
                      WHERE cm.channel_id = $1 AND cm.user_id = u.id) AS is_member
       FROM users u WHERE u.id = $2`,
      [channelId, userId]
    );
    if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
    if (!target.rows[0].is_member) return res.status(400).json({ error: 'The user is not a member of this channel' });
    if (target.rows[0].is_superadmin && !actor.rows[0].is_superadmin) {
      return res.status(403).json({ error: 'Channel moderators cannot timeout a Superadmin' });
    }
    const settings = await query(
      'SELECT default_timeout_minutes, max_timeout_minutes FROM moderation_settings WHERE id = 1'
    );
    const { durationMinutes, reason = '' } = req.body || {};
    const duration = durationMinutes === undefined
      ? settings.rows[0].default_timeout_minutes : durationMinutes;
    if (!Number.isInteger(duration) || duration < 1 || duration > settings.rows[0].max_timeout_minutes
      || typeof reason !== 'string' || reason.length > 500) {
      return res.status(400).json({ error: `Duration must be a whole number from 1 to ${settings.rows[0].max_timeout_minutes} minutes; reason must be at most 500 characters` });
    }
    const result = await query(
      `INSERT INTO channel_timeouts (channel_id, user_id, moderator_id, reason, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 minute'))
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET moderator_id = EXCLUDED.moderator_id,
                     reason = EXCLUDED.reason,
                     expires_at = EXCLUDED.expires_at,
                     created_at = NOW()
       RETURNING id, expires_at`,
      [channelId, userId, req.user.userId, reason.trim(), duration]
    );
    await audit(channelId, req.user.userId, 'user_timed_out', userId, {
      durationMinutes: duration, reason: reason.trim(), expiresAt: result.rows[0].expires_at,
    });
    res.status(201).json({ timeout: { id: result.rows[0].id, expiresAt: result.rows[0].expires_at } });
  } catch (err) {
    sendError(res, err, 'Create channel timeout error');
  }
});

router.delete('/channels/:channelId/timeouts/:userId', async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    const userId = parseId(req.params.userId);
    if (!channelId || !userId) return res.status(400).json({ error: 'Valid channel and user IDs are required' });
    await ensureChannelModerator(query, req.user.userId, channelId);
    const result = await query(
      `DELETE FROM channel_timeouts
       WHERE channel_id = $1 AND user_id = $2 AND expires_at > NOW()
       RETURNING id`,
      [channelId, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Active timeout not found' });
    await audit(channelId, req.user.userId, 'timeout_removed', userId);
    res.json({ removed: true });
  } catch (err) {
    sendError(res, err, 'Remove channel timeout error');
  }
});

router.patch('/channels/:channelId/slowmode', async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    if (!channelId) return res.status(400).json({ error: 'A valid channel ID is required' });
    await ensureChannelModerator(query, req.user.userId, channelId);
    const seconds = req.body?.seconds;
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
      return res.status(400).json({ error: 'Slow mode must be a whole number from 0 to 3600 seconds' });
    }
    const result = await query(
      'UPDATE channels SET slowmode_seconds = $1 WHERE id = $2 RETURNING id',
      [seconds, channelId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Channel not found' });
    await audit(channelId, req.user.userId, 'slowmode_changed', null, { seconds });
    res.json({ slowmodeSeconds: seconds });
  } catch (err) {
    sendError(res, err, 'Update channel slow mode error');
  }
});

router.post('/channels/:channelId/reports', async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    const messageId = parseId(req.body?.messageId);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!channelId || !messageId) return res.status(400).json({ error: 'Valid channel and message IDs are required' });
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: 'Report reason must be between 3 and 500 characters' });
    }
    await ensureChannelMembership(query, req.user.userId, channelId);
    const message = await query(
      'SELECT id FROM messages WHERE id = $1 AND channel_id = $2',
      [messageId, channelId]
    );
    if (!message.rows.length) return res.status(404).json({ error: 'Message not found in this channel' });
    const duplicate = await query(
      `SELECT id FROM message_reports
       WHERE message_id = $1 AND reporter_id = $2 AND status = 'open'`,
      [messageId, req.user.userId]
    );
    if (duplicate.rows.length) return res.status(409).json({ error: 'You already reported this message' });
    const result = await query(
      `INSERT INTO message_reports (channel_id, message_id, reporter_id, reason)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [channelId, messageId, req.user.userId, reason]
    );
    await audit(channelId, req.user.userId, 'message_reported', null, { reportId: result.rows[0].id, messageId });
    res.status(201).json({ reportId: result.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'You already reported this message' });
    sendError(res, err, 'Create message report error');
  }
});

router.patch('/reports/:reportId', async (req, res) => {
  try {
    const reportId = parseId(req.params.reportId);
    const { status } = req.body || {};
    if (!reportId) return res.status(400).json({ error: 'A valid report ID is required' });
    if (!['resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Report status must be resolved or dismissed' });
    }
    const report = await query('SELECT channel_id FROM message_reports WHERE id = $1', [reportId]);
    if (!report.rows.length) return res.status(404).json({ error: 'Report not found' });
    const channelId = report.rows[0].channel_id;
    await ensureChannelModerator(query, req.user.userId, channelId);
    const result = await query(
      `UPDATE message_reports
       SET status = $1, resolved_by = $2, resolved_at = NOW()
       WHERE id = $3 AND status = 'open' RETURNING id`,
      [status, req.user.userId, reportId]
    );
    if (!result.rows.length) return res.status(409).json({ error: 'Report is already closed' });
    await audit(channelId, req.user.userId, `report_${status}`, null, { reportId });
    res.json({ status });
  } catch (err) {
    sendError(res, err, 'Update message report error');
  }
});

router.delete('/messages/:messageId', async (req, res) => {
  try {
    const messageId = parseId(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'A valid message ID is required' });
    const message = await query(
      'SELECT id, channel_id FROM messages WHERE id = $1',
      [messageId]
    );
    if (!message.rows.length) return res.status(404).json({ error: 'Message not found' });
    const channelId = message.rows[0].channel_id;
    await ensureChannelModerator(query, req.user.userId, channelId);
    const attachments = await query(
      'SELECT id, filename FROM files WHERE message_id = $1',
      [messageId]
    );
    const cleanupFailures = [];
    await query('DELETE FROM files WHERE message_id = $1', [messageId]);
    await query('DELETE FROM reactions WHERE message_id = $1', [messageId]);
    await query(
      `UPDATE messages SET content = '[Message removed by a moderator]', edited_at = NOW(),
                           pinned_at = NULL, pinned_by = NULL
       WHERE id = $1`,
      [messageId]
    );
    await audit(channelId, req.user.userId, 'message_deleted', null, { messageId });

    const uploadDirectory = path.resolve(config.UPLOAD_DIR);
    for (const file of attachments.rows) {
      const sharedFile = await query(
        'SELECT 1 FROM files WHERE filename = $1 LIMIT 1',
        [file.filename]
      );
      if (sharedFile.rows.length) continue;
      const filePath = path.resolve(uploadDirectory, file.filename);
      if (path.dirname(filePath) !== uploadDirectory || path.basename(file.filename) !== file.filename) {
        console.error('Skipped invalid attachment path during moderation deletion:', file.id);
        continue;
      }
      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error('Could not remove moderated attachment:', err);
          cleanupFailures.push(file.id);
        }
      }
      req.io?.to(`channel_${channelId}`).emit('file_deleted', {
        fileId: file.id, messageId, channelId,
      });
    }
    req.io?.to(`channel_${channelId}`).emit('message_deleted', { messageId, channelId });
    if (cleanupFailures.length) {
      return res.status(500).json({
        error: 'The message was removed, but some stored attachments could not be deleted. Contact the workspace administrator.',
      });
    }
    res.json({ deleted: true, messageId });
  } catch (err) {
    sendError(res, err, 'Moderate message deletion error');
  }
});

// ---- slow mode for the whole workspace (Superadmin) ----

const slowSeconds = (value) => (Number.isInteger(value) && value >= 0 && value <= 3600 ? value : null);

// GET /api/moderation/slowmode-policy - the slow mode new channels start with
router.get('/slowmode-policy', async (req, res) => {
  try {
    await requireWorkspacePermission(req.user.userId, 'manage_workspace');
    const row = (await query('SELECT default_slowmode_seconds FROM moderation_settings WHERE id = 1')).rows[0];
    res.json({ defaultSeconds: row ? row.default_slowmode_seconds : 5 });
  } catch (err) {
    sendError(res, err, 'Get slow mode policy error');
  }
});

// PUT /api/moderation/slowmode-policy - { defaultSeconds } for channels created from now on
router.put('/slowmode-policy', async (req, res) => {
  try {
    await requireWorkspacePermission(req.user.userId, 'manage_workspace');
    const seconds = slowSeconds(req.body && req.body.defaultSeconds);
    if (seconds === null) return res.status(400).json({ error: 'Slow mode must be whole seconds from 0 to 3600' });
    await query('UPDATE moderation_settings SET default_slowmode_seconds = $1, updated_by = $2, updated_at = NOW() WHERE id = 1', [seconds, req.user.userId]);
    await audit(null, req.user.userId, 'default_slowmode_changed', null, { seconds });
    res.json({ defaultSeconds: seconds });
  } catch (err) {
    sendError(res, err, 'Set slow mode policy error');
  }
});

// POST /api/moderation/slowmode-all - { seconds }: set the same slow mode on every existing channel
router.post('/slowmode-all', async (req, res) => {
  try {
    await requireWorkspacePermission(req.user.userId, 'manage_workspace');
    const seconds = slowSeconds(req.body && req.body.seconds);
    if (seconds === null) return res.status(400).json({ error: 'Slow mode must be whole seconds from 0 to 3600' });
    const result = await query('UPDATE channels SET slowmode_seconds = $1 RETURNING id', [seconds]);
    await audit(null, req.user.userId, 'slowmode_set_for_all_channels', null, { seconds, channels: result.rows.length });
    res.json({ seconds, channels: result.rows.length });
  } catch (err) {
    sendError(res, err, 'Set slow mode for all channels error');
  }
});

// ---- removing a channel ----

// DELETE /api/moderation/channels/:channelId - the Superadmin, or the person who created the channel, deletes it.
// Its messages, files, canvas, lists, links and members go with it; the audit log keeps the record.
router.delete('/channels/:channelId', async (req, res) => {
  try {
    const channelId = parseId(req.params.channelId);
    if (!channelId) return res.status(400).json({ error: 'A valid channel ID is required' });
    const channel = (await query('SELECT id, name, created_by FROM channels WHERE id = $1', [channelId])).rows[0];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const actor = (await query('SELECT is_superadmin FROM users WHERE id = $1', [req.user.userId])).rows[0];
    const allowed = Boolean(actor && actor.is_superadmin) || Number(channel.created_by) === Number(req.user.userId);
    if (!allowed) return res.status(403).json({ error: 'Only the Superadmin or the person who created the channel can delete it' });

    const members = (await query('SELECT user_id FROM channel_members WHERE channel_id = $1', [channelId])).rows.map((r) => r.user_id);
    const files = (await query(
      `SELECT DISTINCT f.filename FROM files f
       LEFT JOIN messages m ON m.id = f.message_id
       LEFT JOIN canvases c ON c.id = f.canvas_id
       WHERE m.channel_id = $1 OR c.channel_id = $1`,
      [channelId]
    )).rows;
    await audit(null, req.user.userId, 'channel_deleted', null, { channelId, name: channel.name, members: members.length });
    await query('DELETE FROM channels WHERE id = $1', [channelId]); // everything that belongs to it cascades
    for (const row of files) {
      fs.promises.unlink(path.join(config.UPLOAD_DIR, row.filename)).catch(() => {});
    }
    members.forEach((id) => req.io?.to(`user_${id}`).emit('channel_deleted', { channelId, name: channel.name }));
    req.io?.to(`channel_${channelId}`).emit('channel_deleted', { channelId, name: channel.name });
    res.json({ id: channelId, name: channel.name, filesRemoved: files.length });
  } catch (err) {
    sendError(res, err, 'Delete channel error');
  }
});

module.exports = router;
