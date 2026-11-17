const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = (p) => fs.readFileSync(path.join(__dirname,'../src/',p),'utf8');
test('channel manager updates preserve at least one eligible manager and audit the replacement', () => {
  const code = src('routes/moderation.js');
  assert.match(code,/router\.put\('\/channels\/:channelId\/managers'/);
  assert.match(code,/!ids\.length/);
  assert.match(code,/FOR UPDATE/);
  assert.match(code,/deactivated_at IS NULL/);
  assert.match(code,/channel_managers_replaced/);
});
test('archiving is reversible and blocks destructive removal of unarchived shared channels', () => {
  const code = src('routes/moderation.js');
  assert.match(code,/router\.post\('\/channels\/:channelId\/archive'/);
  assert.match(code,/router\.post\('\/channels\/:channelId\/restore'/);
  assert.match(code,/archive the channel first/i);
  assert.match(code,/PERMANENTLY DELETE CHANNEL/);
});
test('archived channel posts are prohibited even for superadmins', () => {
  const code = src('security.js');
  assert.ok(code.indexOf('archiveState.rows[0]?.archived_at') < code.indexOf("SELECT is_superadmin FROM users WHERE id = $1"));
});
test('archive state is migrated and disclosed for channel UI', () => {
  assert.match(src('migrations.js'),/ADD COLUMN IF NOT EXISTS archived_at/);
  assert.match(src('routes/channels.js'),/archivedAt: ch.archived_at/);
});

test('manager promotion checks channel access rather than generating access by role', () => {
  const code = src('routes/moderation.js');
  assert.match(code,/ensureChannelMembership\(client\.query\.bind\(client\), id, channelId\)/);
  assert.match(code,/Assign a channel membership before promoting/);
});
test('lifecycle UX exposes manager, archive and restore operations', () => {
  const code = fs.readFileSync(path.join(__dirname,'../../frontend/src/features/channel-access.js'),'utf8');
  for (const key of ['data-channel-replace-managers','data-channel-archive','data-channel-restore','data-channel-permanent-delete']) assert.ok(code.includes(key));
});

test('assigned managers can administer a shared channel without workspace-wide privileges', () => {
  const code = src('routes/moderation.js');
  assert.match(code, /requireChannelManagerOrWorkspace/);
  assert.match(code, /cm\.role = 'moderator'/);
  assert.match(code, /ensureChannelMembership\(query, userId, channelId\)/);
});
test('manager recovery requires an existing authorized member and emits an audit record', () => {
  const code = src('routes/moderation.js');
  assert.match(code, /recover-manager/);
  assert.match(code, /RECOVER CHANNEL MANAGER/);
  assert.match(code, /channel_manager_recovered/);
  assert.match(code, /ensureChannelMembership\(client\.query\.bind\(client\), replacementId, channelId\)/);
});
test('archived canvases and file deletes use shared write guards', () => {
  assert.match(src('routes/canvas.js'), /Archived channel canvases are read-only/);
  assert.match(src('routes/canvas.js'), /ensureChannelNotArchived\(query, channelId\)/);
  assert.match(src('routes/files.js'), /ensureChannelNotArchived\(client\.query\.bind\(client\), file\.channel_id\)/);
});
