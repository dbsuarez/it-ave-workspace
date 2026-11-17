// Whether a Superadmin (Owner) may open private channels they are not a member of.
//
// This is a workspace switch (moderation_settings.owner_private_channel_access), OFF by default: with it off,
// an Owner needs a membership, department grant or invitation to read or post in a private channel, like anyone
// else. Public channels are unaffected. Administration of a channel (managers, archive, recovery, deletion) never
// depended on reading its content and is unchanged. Switching it on or off is an Owner action and is audited.
const SETTING_SQL = '(SELECT owner_private_channel_access FROM moderation_settings WHERE id = 1)';

// SQL predicate: this user is a Superadmin who may see this channel. Pass the SQL aliases of the users row and the
// channels row, e.g. superadminMaySee('u', 'c').
function superadminMaySee(userAlias, channelAlias) {
  return `(${userAlias}.is_superadmin = TRUE AND (COALESCE(${channelAlias}.is_private, FALSE) = FALSE OR ${SETTING_SQL}))`;
}

async function isEnabled(query) {
  const result = await query('SELECT owner_private_channel_access FROM moderation_settings WHERE id = 1');
  return Boolean(result.rows[0] && result.rows[0].owner_private_channel_access);
}

module.exports = { SETTING_SQL, superadminMaySee, isEnabled };
