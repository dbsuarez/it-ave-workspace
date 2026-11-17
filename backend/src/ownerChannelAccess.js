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

// While the switch is off an Owner may not grant THEMSELVES access to a private channel through administration
// either: not as a member, not by invitation, and not through a department they belong to. A channel manager (or
// another Owner) inviting them is a decision by someone else and stays allowed. Throws a 403 to stop the request.
async function refuseOwnerSelfGrant(query, actorId, channelId, { userIds = [], departmentIds = [] } = {}) {
  const channel = (await query('SELECT is_private, is_personal FROM channels WHERE id = $1', [channelId])).rows[0];
  if (!channel || !channel.is_private || channel.is_personal) return;
  const actor = (await query('SELECT is_superadmin, department_id FROM users WHERE id = $1', [actorId])).rows[0];
  if (!actor || !actor.is_superadmin || await isEnabled(query)) return;
  let self = userIds.map(Number).includes(Number(actorId));
  if (!self && departmentIds.length) {
    const own = (await query('SELECT department_id FROM user_departments WHERE user_id = $1', [actorId])).rows.map((r) => Number(r.department_id));
    if (actor.department_id) own.push(Number(actor.department_id));
    self = departmentIds.map(Number).some((id) => own.includes(id));
  }
  if (self) {
    throw Object.assign(new Error('Owners cannot give themselves access to a private channel while "Owner access to private channels" is off. Ask a channel manager to invite you, or turn the switch on (Moderation > Superadmin).'), { status: 403 });
  }
}

module.exports = { SETTING_SQL, superadminMaySee, isEnabled, refuseOwnerSelfGrant };
