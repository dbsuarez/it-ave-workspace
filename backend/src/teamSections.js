async function syncReportTeamChannels(query, userId, oldManagerId, newManagerId) {
  if (oldManagerId && Number(oldManagerId) !== Number(newManagerId)) {
    await query(
      `DELETE FROM channel_members cm USING channels c, team_sidebar_sections ts
       WHERE cm.channel_id = c.id AND c.team_section_id = ts.id
         AND ts.owner_id = $1 AND cm.user_id = $2`,
      [oldManagerId, userId]
    );
  }
  if (newManagerId) {
    await query(
      `INSERT INTO channel_members (channel_id, user_id, role)
       SELECT c.id, $2, 'member' FROM channels c
       JOIN team_sidebar_sections ts ON ts.id = c.team_section_id
       WHERE ts.owner_id = $1
       ON CONFLICT (channel_id, user_id) DO UPDATE SET role = 'member'`,
      [newManagerId, userId]
    );
  }
}

module.exports = { syncReportTeamChannels };
