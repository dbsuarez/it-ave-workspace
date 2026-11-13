const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { can, requirePermission } = require('../permissions');

const router = express.Router();
router.use(authenticateToken);

const NOTIFICATION_DEFAULTS = Object.freeze({
  mentions: true,
  directMessages: true,
  replies: true,
  reactions: true,
  channelMessages: false,
  desktop: true,
  sound: true,
});
const MAX_DND_MINUTES = 7 * 24 * 60;

function mergeNotificationPrefs(stored, changes) {
  const merged = { ...NOTIFICATION_DEFAULTS };
  for (const key of Object.keys(NOTIFICATION_DEFAULTS)) {
    if (stored && typeof stored[key] === 'boolean') merged[key] = stored[key];
  }
  if (changes !== undefined) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw Object.assign(new Error('Notifications must be an object of on/off settings'), { status: 400 });
    }
    for (const [key, value] of Object.entries(changes)) {
      if (!(key in NOTIFICATION_DEFAULTS)) {
        throw Object.assign(new Error(`Unknown notification setting: ${key}`), { status: 400 });
      }
      if (typeof value !== 'boolean') {
        throw Object.assign(new Error(`Notification setting ${key} must be true or false`), { status: 400 });
      }
      merged[key] = value;
    }
  }
  return merged;
}

// A single emoji (or nothing). Uses the same grapheme rule as reactions.
function isSingleEmojiOrEmpty(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 16) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(value);
}

function serialize(row) {
  const dndUntil = row.dnd_until && new Date(row.dnd_until) > new Date() ? row.dnd_until : null;
  return {
    notifications: mergeNotificationPrefs(row.notification_prefs),
    dndUntil,
    statusText: row.status_text || '',
    statusEmoji: row.status_emoji || '',
  };
}

router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT notification_prefs, dnd_until, status_text, status_emoji FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ settings: serialize(result.rows[0]) });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/settings - partial update. `dndMinutes` of 0 turns Do Not Disturb off.
router.put('/', async (req, res) => {
  try {
    const { notifications, dndMinutes, statusText, statusEmoji } = req.body || {};
    const current = await query(
      'SELECT notification_prefs, dnd_until, status_text, status_emoji FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'User not found' });
    const row = current.rows[0];

    const prefs = mergeNotificationPrefs(row.notification_prefs, notifications);

    let dndUntil = row.dnd_until;
    if (dndMinutes !== undefined) {
      if (!Number.isInteger(dndMinutes) || dndMinutes < 0 || dndMinutes > MAX_DND_MINUTES) {
        return res.status(400).json({ error: `Pause duration must be a whole number of minutes from 0 to ${MAX_DND_MINUTES}` });
      }
      dndUntil = dndMinutes === 0 ? null : new Date(Date.now() + dndMinutes * 60 * 1000);
    }

    let text = row.status_text || '';
    if (statusText !== undefined) {
      if (typeof statusText !== 'string' || statusText.trim().length > 100) {
        return res.status(400).json({ error: 'Status must be 100 characters or fewer' });
      }
      text = statusText.trim();
    }

    let emoji = row.status_emoji || '';
    if (statusEmoji !== undefined) {
      if (!isSingleEmojiOrEmpty(statusEmoji)) {
        return res.status(400).json({ error: 'Status emoji must be a single emoji or empty' });
      }
      emoji = statusEmoji;
    }

    const updated = await query(
      `UPDATE users
       SET notification_prefs = $1, dnd_until = $2, status_text = $3, status_emoji = $4
       WHERE id = $5
       RETURNING notification_prefs, dnd_until, status_text, status_emoji`,
      [JSON.stringify(prefs), dndUntil, text, emoji, req.user.userId]
    );
    const settings = serialize(updated.rows[0]);

    // Everyone sees status and whether notifications are paused.
    req.io?.emit('user_status_updated', {
      userId: req.user.userId,
      statusText: settings.statusText,
      statusEmoji: settings.statusEmoji,
      dndUntil: settings.dndUntil,
    });
    res.json({ settings });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Personal sidebar sections ----
const MAX_SECTIONS = 20;

// Validates and normalises a sidebar layout: named sections, each holding
// channel IDs. A channel can sit in at most one section.
function normalizeSidebarLayout(input) {
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  if (!input || typeof input !== 'object' || !Array.isArray(input.sections)) {
    throw fail('Layout must have a list of sections');
  }
  if (input.sections.length > MAX_SECTIONS) throw fail(`You can have at most ${MAX_SECTIONS} sections`);
  const seenIds = new Set();
  const seenChannels = new Set();
  const sections = input.sections.map((section) => {
    const id = typeof section?.id === 'string' ? section.id.trim() : '';
    const name = typeof section?.name === 'string' ? section.name.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw fail('Each section needs a short ID');
    if (seenIds.has(id)) throw fail('Section IDs must be unique');
    seenIds.add(id);
    if (!name || name.length > 40) throw fail('Section names must be 1 to 40 characters');
    if (!Array.isArray(section.channelIds)) throw fail('Each section needs a list of channel IDs');
    const channelIds = [];
    for (const raw of section.channelIds) {
      const channelId = Number(raw);
      if (!Number.isSafeInteger(channelId) || channelId < 1) throw fail('Channel IDs must be positive whole numbers');
      if (seenChannels.has(channelId)) throw fail('A channel can only be in one section');
      seenChannels.add(channelId);
      channelIds.push(channelId);
    }
    return { id, name, channelIds, collapsed: Boolean(section.collapsed) };
  });
  const workspaceCollapsed = Array.isArray(input.workspaceCollapsed)
    ? [...new Set(input.workspaceCollapsed.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id)))]
    : [];
  return { sections, workspaceCollapsed };
}

function normalizeWorkspaceSidebarLayout(input) {
  const normalized = normalizeSidebarLayout(input);
  return { sections: normalized.sections.map(({ id, name, channelIds }) => ({ id, name, channelIds })) };
}

function withoutLockedChannels(layout, workspaceLayout, personalChannelIds = [], teamChannelIds = []) {
  const locked = new Set([
    ...(workspaceLayout.sections || []).flatMap((section) => section.channelIds || []).map(Number),
    ...personalChannelIds.map(Number),
    ...teamChannelIds.map(Number),
  ]);
  return {
    sections: (layout.sections || []).map((section) => ({
      ...section,
      channelIds: (section.channelIds || []).filter((id) => !locked.has(Number(id))),
    })),
    workspaceCollapsed: layout.workspaceCollapsed || [],
  };
}

router.get('/sidebar', async (req, res) => {
  try {
    const [userResult, workspaceResult, personalResult, teamResult, directReports, canManageWorkspaceSections] = await Promise.all([
      query('SELECT sidebar_layout FROM users WHERE id = $1', [req.user.userId]),
      query('SELECT workspace_sidebar_layout FROM moderation_settings WHERE id = 1'),
      query('SELECT id FROM channels WHERE created_by = $1 AND is_personal = TRUE', [req.user.userId]),
      query(`SELECT ts.id, ts.name, ts.owner_id, owner.username AS owner_username,
                    COALESCE(array_agg(c.id ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL), '{}') AS channel_ids
             FROM team_sidebar_sections ts
             JOIN users owner ON owner.id = ts.owner_id
             LEFT JOIN channels c ON c.team_section_id = ts.id
             WHERE ts.owner_id = $1 OR EXISTS (
               SELECT 1 FROM users me WHERE me.id = $1 AND me.manager_id = ts.owner_id
             )
             GROUP BY ts.id, owner.username ORDER BY LOWER(ts.name)`, [req.user.userId]),
      query("SELECT COUNT(*)::integer AS count FROM users WHERE manager_id = $1 AND account_type = 'member' AND deactivated_at IS NULL", [req.user.userId]),
      can(query, req.user.userId, 'manage_workspace'),
    ]);
    const stored = userResult.rows[0]?.sidebar_layout;
    const workspaceLayout = workspaceResult.rows[0]?.workspace_sidebar_layout || { sections: [] };
    const personal = withoutLockedChannels(
      stored && Array.isArray(stored.sections) ? { sections: stored.sections, workspaceCollapsed: stored.workspaceCollapsed || [] } : { sections: [], workspaceCollapsed: [] },
      workspaceLayout,
      personalResult.rows.map((row) => row.id),
      teamResult.rows.flatMap((row) => row.channel_ids || [])
    );
    const teamSections = teamResult.rows.map((row) => ({
      id: `team-${row.id}`, teamSectionId: row.id, name: row.name, ownerId: row.owner_id,
      ownerUsername: row.owner_username, editable: Number(row.owner_id) === Number(req.user.userId),
      channelIds: (row.channel_ids || []).map(Number),
    }));
    res.json({ layout: { ...personal, workspaceSections: workspaceLayout.sections || [], teamSections,
      canCreateTeamSections: Number(directReports.rows[0]?.count || 0) > 0, canManageWorkspaceSections } });
  } catch (err) {
    console.error('Get sidebar layout error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/sidebar/team', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 40) return res.status(400).json({ error: 'Team section names must be 1 to 40 characters' });
    const reports = await query("SELECT 1 FROM users WHERE manager_id = $1 AND account_type = 'member' AND deactivated_at IS NULL LIMIT 1", [req.user.userId]);
    if (!reports.rows.length) return res.status(403).json({ error: 'A team section requires at least one direct report' });
    const count = await query('SELECT COUNT(*)::integer AS count FROM team_sidebar_sections WHERE owner_id = $1', [req.user.userId]);
    if (Number(count.rows[0]?.count || 0) >= 10) return res.status(400).json({ error: 'You can have at most 10 team sections' });
    const created = await query('INSERT INTO team_sidebar_sections (name, owner_id) VALUES ($1, $2) RETURNING id, name, owner_id', [name, req.user.userId]);
    req.io?.emit('team_sections_updated');
    res.status(201).json({ section: created.rows[0] });
  } catch (err) {
    console.error('Create team section error:', err); res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/sidebar/team/:id', async (req, res) => {
  try {
    const id = Number(req.params.id); const name = String(req.body?.name || '').trim();
    if (!Number.isSafeInteger(id) || id < 1 || !name || name.length > 40) return res.status(400).json({ error: 'A valid team section and name are required' });
    const updated = await query('UPDATE team_sidebar_sections SET name = $1 WHERE id = $2 AND owner_id = $3 RETURNING id, name', [name, id, req.user.userId]);
    if (!updated.rows.length) return res.status(403).json({ error: 'Only the team leader can rename this section' });
    req.io?.emit('team_sections_updated'); res.json({ section: updated.rows[0] });
  } catch (err) { console.error('Rename team section error:', err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/sidebar/team/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'A valid team section is required' });
    const removed = await query('DELETE FROM team_sidebar_sections WHERE id = $1 AND owner_id = $2 RETURNING id, name', [id, req.user.userId]);
    if (!removed.rows.length) return res.status(403).json({ error: 'Only the team leader can delete this section' });
    req.io?.emit('team_sections_updated'); res.json({ section: removed.rows[0] });
  } catch (err) { console.error('Delete team section error:', err); res.status(500).json({ error: 'Server error' }); }
});

router.put('/sidebar', async (req, res) => {
  try {
    const layout = normalizeSidebarLayout(req.body?.layout);
    const workspaceLayout = (await query('SELECT workspace_sidebar_layout FROM moderation_settings WHERE id = 1')).rows[0]?.workspace_sidebar_layout || { sections: [] };
    const locked = new Set((workspaceLayout.sections || []).flatMap((section) => section.channelIds || []).map(Number));
    const personal = new Set((await query('SELECT id FROM channels WHERE created_by = $1 AND is_personal = TRUE', [req.user.userId])).rows.map((row) => Number(row.id)));
    const team = new Set((await query(
      `SELECT c.id FROM channels c JOIN team_sidebar_sections ts ON ts.id = c.team_section_id
       WHERE ts.owner_id = $1 OR EXISTS (SELECT 1 FROM users me WHERE me.id = $1 AND me.manager_id = ts.owner_id)`,
      [req.user.userId]
    )).rows.map((row) => Number(row.id)));
    if (layout.sections.some((section) => section.channelIds.some((id) => locked.has(Number(id))))) {
      return res.status(400).json({ error: 'Workspace section channels cannot be moved into personal sections' });
    }
    if (layout.sections.some((section) => section.channelIds.some((id) => personal.has(Number(id))))) {
      return res.status(400).json({ error: 'Personal channels stay in Personal Channels' });
    }
    if (layout.sections.some((section) => section.channelIds.some((id) => team.has(Number(id))))) {
      return res.status(400).json({ error: 'Team channels stay in their Team Section' });
    }
    await query('UPDATE users SET sidebar_layout = $1 WHERE id = $2', [JSON.stringify(layout), req.user.userId]);
    res.json({ layout: { ...layout, workspaceSections: workspaceLayout.sections || [], canManageWorkspaceSections: await can(query, req.user.userId, 'manage_workspace') } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Save sidebar layout error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/sidebar/workspace', async (req, res) => {
  try {
    await requirePermission(query, req.user.userId, 'manage_workspace');
    const layout = normalizeWorkspaceSidebarLayout(req.body?.layout);
    const ids = layout.sections.flatMap((section) => section.channelIds);
    if (ids.length) {
      const personal = await query('SELECT 1 FROM channels WHERE id = ANY($1::int[]) AND (is_personal = TRUE OR team_section_id IS NOT NULL) LIMIT 1', [ids]);
      if (personal.rows.length) return res.status(400).json({ error: 'Personal and team channels cannot be placed in workspace sections' });
    }
    await query(
      'UPDATE moderation_settings SET workspace_sidebar_layout = $1, updated_by = $2, updated_at = NOW() WHERE id = 1',
      [JSON.stringify(layout), req.user.userId]
    );
    req.io?.emit('workspace_sections_updated');
    res.json({ layout });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Save workspace sidebar layout error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.normalizeSidebarLayout = normalizeSidebarLayout;
module.exports.normalizeWorkspaceSidebarLayout = normalizeWorkspaceSidebarLayout;
module.exports.mergeNotificationPrefs = mergeNotificationPrefs;
module.exports.isSingleEmojiOrEmpty = isSingleEmojiOrEmpty;
module.exports.NOTIFICATION_DEFAULTS = NOTIFICATION_DEFAULTS;
