const DEFAULT_CHANNELS = [
  ['welcome', 'Start here for workspace guidance and onboarding information.'],
  ['announcements', 'Official company announcements.'],
  ['general', 'Company-wide discussion.'],
];

const DEFAULT_SECTION = Object.freeze({ id: 'builtin-start-here', name: 'START HERE' });

function withDefaultSection(layout, channelIds) {
  const locked = new Set(channelIds.map(Number));
  const sections = (layout?.sections || [])
    .filter((section) => section.id !== DEFAULT_SECTION.id)
    .map((section) => ({ ...section, channelIds: (section.channelIds || []).filter((id) => !locked.has(Number(id))) }));
  return { sections: [{ ...DEFAULT_SECTION, builtIn: true, channelIds: channelIds.map(Number) }, ...sections] };
}

async function ensureDefaultChannels(target) {
  for (const [name, topic] of DEFAULT_CHANNELS) {
    await target.query(
      `INSERT INTO channels (name, topic, is_private, is_personal, available_to_all, command_scope, created_by)
       VALUES ($1, $2, FALSE, FALSE, TRUE, NULL, NULL)
       ON CONFLICT (name) DO UPDATE SET created_by = NULL, available_to_all = TRUE`,
      [name, topic]
    );
  }
  await target.query(
    `INSERT INTO channel_members (channel_id, user_id)
     SELECT c.id, u.id
     FROM channels c CROSS JOIN users u
     WHERE c.name = ANY($1::text[])
       AND u.account_type = 'member' AND u.deactivated_at IS NULL
     ON CONFLICT DO NOTHING`,
    [DEFAULT_CHANNELS.map(([name]) => name)]
  );
  const channels = (await target.query(
    'SELECT id FROM channels WHERE name = ANY($1::text[]) ORDER BY array_position($1::text[], name)',
    [DEFAULT_CHANNELS.map(([name]) => name)]
  )).rows;
  const stored = (await target.query('SELECT workspace_sidebar_layout FROM moderation_settings WHERE id = 1')).rows[0]?.workspace_sidebar_layout;
  const layout = withDefaultSection(stored, channels.map((channel) => channel.id));
  await target.query('UPDATE moderation_settings SET workspace_sidebar_layout = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(layout)]);
  return layout;
}

module.exports = { DEFAULT_CHANNELS, DEFAULT_SECTION, ensureDefaultChannels, withDefaultSection };
