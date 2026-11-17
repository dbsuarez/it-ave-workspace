// Shared channel visibility predicate for content listing and search.
// The caller must supply the viewer ID in SQL parameter $1.
const { superadminMaySee } = require('./ownerChannelAccess');

function channelVisibleToUser(channelExpression) {
  return `EXISTS (
    SELECT 1 FROM channels permitted_channel
    JOIN users viewer ON viewer.id = $1 AND viewer.deactivated_at IS NULL
    WHERE permitted_channel.id = ${channelExpression}
      AND NOT EXISTS (
        SELECT 1 FROM channel_bans cb WHERE cb.channel_id = permitted_channel.id AND cb.user_id = $1
      )
      AND (
        (permitted_channel.is_personal = TRUE AND permitted_channel.created_by = $1)
        OR (permitted_channel.is_personal = FALSE AND (
          ${superadminMaySee('viewer', 'permitted_channel')}
          OR permitted_channel.id IN (SELECT channel_id FROM channel_members WHERE user_id = $1)
          OR EXISTS (
            SELECT 1 FROM channel_overrides co
            WHERE co.channel_id = permitted_channel.id AND co.subject_type = 'department'
              AND co.subject_id = viewer.department_id AND 'view_channel' = ANY(co.allow)
          )
          OR EXISTS (
            SELECT 1 FROM channel_department_grants cdg
            JOIN user_departments ud ON ud.department_id = cdg.department_id
            WHERE cdg.channel_id = permitted_channel.id AND ud.user_id = $1
          )
          OR EXISTS (
            SELECT 1 FROM channel_direct_grants dg
            WHERE dg.channel_id = permitted_channel.id AND dg.user_id = $1
              AND (dg.expires_at IS NULL OR dg.expires_at > NOW())
          )
        ))
      )
  )`;
}

module.exports = { channelVisibleToUser };
