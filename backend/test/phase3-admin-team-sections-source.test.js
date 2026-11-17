const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/routes/settings.js'), 'utf8');
test('admin team sections require live channel authorization and deduplicate inherited placement', () => {
  assert.match(source, /viewer\.is_superadmin = TRUE/);
  assert.match(source, /await ensureChannelMembership\(query, req\.user\.userId, id\)/);
  assert.match(source, /!teamPlaced\.has\(id\)/);
  assert.match(source, /!workspaceLocked\.has\(id\)/);
  assert.match(source, /if \(!channelIds\.length && Number\(row\.owner_id\) !== Number\(req\.user\.userId\)\) continue/);
});
