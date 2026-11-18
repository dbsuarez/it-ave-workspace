// Built-in channels: channels every member is in and nobody can leave, rename, archive or delete (channels.builtin).
// Four are required by the app and always built-in (DEFAULT_CHANNELS); an Owner can mark others built-in, and turn that off
// again, which makes them ordinary channels. Built-in channels are listed in the locked OFFICIAL section.
const DEFAULT_CHANNELS = [
  ['welcome', 'Start here for workspace guidance and onboarding information.'],
  ['rules', 'The workspace rules and code of conduct. Read them before you start.'],
  ['announcements', 'Official company announcements.'],
  ['general', 'Company-wide discussion.'],
];
const DEFAULT_CHANNEL_NAMES = DEFAULT_CHANNELS.map(([name]) => name);

const DEFAULT_SECTION = Object.freeze({ id: 'builtin-official', name: 'OFFICIAL' });
const RETIRED_SECTION_IDS = new Set(['builtin-start-here', DEFAULT_SECTION.id]);

const fail = (status, message) => Object.assign(new Error(message), { status });

// channelIds: the built-in channels, in display order. removeIds: channels that just stopped being built-in.
function withDefaultSection(layout, channelIds, { removeIds = [] } = {}) {
  const locked = new Set(channelIds.map(Number));
  const removed = new Set(removeIds.map(Number));
  const stored = layout?.sections || [];
  const claimed = stored.filter((section) => RETIRED_SECTION_IDS.has(section.id)
    || String(section.name || '').trim().toLowerCase() === 'official');
  // an Owner who reordered the built-in channels has that order remembered (customOrder); otherwise they follow `channelIds`
  const customOrder = claimed.some((section) => section.customOrder === true);
  const storedIds = [...new Set(claimed.flatMap((section) => section.channelIds || []).map(Number))];
  const ordered = customOrder
    ? [...storedIds.filter((id) => locked.has(id)), ...channelIds.map(Number).filter((id) => !storedIds.includes(id))]
    : channelIds.map(Number);
  // anything else an Owner placed in OFFICIAL keeps its place first; the built-in channels follow
  const officialChannelIds = [...new Set([...storedIds.filter((id) => !locked.has(id) && !removed.has(id)), ...ordered])];
  const sections = stored
    .filter((section) => !claimed.includes(section))
    .map((section) => ({ ...section, channelIds: (section.channelIds || []).filter((id) => !locked.has(Number(id))) }));
  return { sections: [{ ...DEFAULT_SECTION, builtIn: true, ...(customOrder ? { customOrder: true } : {}), channelIds: officialChannelIds }, ...sections] };
}

// Ids of the built-in channels: the required four in their order, then the others in the order they were made.
async function builtInChannelIds(target) {
  const rows = (await target.query(
    `SELECT id FROM channels WHERE builtin = TRUE AND archived_at IS NULL
     ORDER BY COALESCE(array_position($1::text[], name), 9999), id`,
    [DEFAULT_CHANNEL_NAMES]
  )).rows;
  return rows.map((row) => row.id);
}

// Puts every active member in every built-in channel and rebuilds the OFFICIAL section. Safe to repeat.
async function syncBuiltInChannels(target, { removeIds = [] } = {}) {
  await target.query(
    `INSERT INTO channel_members (channel_id, user_id)
     SELECT c.id, u.id FROM channels c CROSS JOIN users u
     WHERE c.builtin = TRUE AND u.account_type = 'member' AND u.deactivated_at IS NULL
     ON CONFLICT DO NOTHING`
  );
  const ids = await builtInChannelIds(target);
  const stored = (await target.query('SELECT workspace_sidebar_layout FROM moderation_settings WHERE id = 1')).rows[0]?.workspace_sidebar_layout;
  const layout = withDefaultSection(stored, ids, { removeIds });
  await target.query('UPDATE moderation_settings SET workspace_sidebar_layout = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(layout)]);
  return layout;
}

// The Owner's chosen order of the built-in channels: orderedIds must hold every built-in channel exactly once.
async function setBuiltInOrder(target, orderedIds) {
  const current = (await builtInChannelIds(target)).map(Number);
  const wanted = Array.isArray(orderedIds) ? orderedIds.map(Number) : [];
  if (wanted.length !== current.length || new Set(wanted).size !== wanted.length || !wanted.every((id) => current.includes(id))) {
    throw fail(400, 'Send every built-in channel exactly once');
  }
  const stored = (await target.query('SELECT workspace_sidebar_layout FROM moderation_settings WHERE id = 1')).rows[0]?.workspace_sidebar_layout;
  // the requested order replaces the remembered one, so the old flag is dropped before the sections are rebuilt
  const withoutOrder = { ...stored, sections: (stored?.sections || []).map(({ customOrder, ...section }) => section) };
  const layout = withDefaultSection(withoutOrder, wanted);
  layout.sections[0].customOrder = true;
  await target.query('UPDATE moderation_settings SET workspace_sidebar_layout = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(layout)]);
  return layout;
}

// A new member joins the built-in channels (call it after creating an account).
async function joinBuiltInChannels(query, userId) {
  await query(
    `INSERT INTO channel_members (channel_id, user_id)
     SELECT c.id, u.id FROM channels c JOIN users u ON u.id = $1
     WHERE c.builtin = TRUE AND c.archived_at IS NULL AND u.account_type = 'member' AND u.deactivated_at IS NULL
     ON CONFLICT DO NOTHING`,
    [userId]
  );
}

// Marks or unmarks a channel as built-in (the caller has checked that the person is an Owner). Throws errors with a status.
async function setChannelBuiltIn(target, channelId, on) {
  const channel = (await target.query('SELECT id, name, is_private, is_personal, kind, archived_at, builtin FROM channels WHERE id = $1', [channelId])).rows[0];
  if (!channel) throw fail(404, 'Channel not found');
  if (on) {
    if (channel.is_personal) throw fail(409, 'A personal channel cannot be built-in');
    if (channel.kind === 'forum') throw fail(409, 'A department forum cannot be built-in');
    if (channel.is_private) throw fail(409, 'A private channel cannot be built-in. Make it public first, since everyone joins a built-in channel');
    if (channel.archived_at) throw fail(409, 'An archived channel cannot be built-in');
    await target.query('UPDATE channels SET builtin = TRUE, available_to_all = TRUE WHERE id = $1', [channelId]);
    await syncBuiltInChannels(target);
  } else {
    if (DEFAULT_CHANNEL_NAMES.includes(channel.name)) throw fail(409, `#${channel.name} is required by the app and stays built-in`);
    await target.query('UPDATE channels SET builtin = FALSE WHERE id = $1', [channelId]);
    await syncBuiltInChannels(target, { removeIds: [channelId] });
  }
  return { changed: Boolean(channel.builtin) !== on };
}

async function ensureDefaultChannels(target) {
  for (const [name, topic] of DEFAULT_CHANNELS) {
    await target.query(
      `INSERT INTO channels (name, topic, is_private, is_personal, available_to_all, command_scope, created_by, builtin)
       VALUES ($1, $2, FALSE, FALSE, TRUE, NULL, NULL, TRUE)
       ON CONFLICT (name) DO UPDATE SET created_by = NULL, available_to_all = TRUE, builtin = TRUE`,
      [name, topic]
    );
  }
  // /announce works in the built-in #announcements channel (an Owner can tag other channels in Moderation)
  await target.query("UPDATE channels SET command_scope = 'announcements' WHERE name = 'announcements' AND command_scope IS NULL");
  return syncBuiltInChannels(target);
}

module.exports = {
  DEFAULT_CHANNELS, DEFAULT_CHANNEL_NAMES, DEFAULT_SECTION, ensureDefaultChannels, withDefaultSection,
  builtInChannelIds, syncBuiltInChannels, joinBuiltInChannels, setChannelBuiltIn, setBuiltInOrder,
};
