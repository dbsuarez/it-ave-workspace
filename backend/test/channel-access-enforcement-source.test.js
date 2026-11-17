const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

test('channel membership honors bans even for legacy members and owners', () => {
  const source = read('security.js');
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM channel_bans b WHERE b.channel_id = \$1 AND b.user_id = u.id\)/);
  assert.match(source, /u.deactivated_at IS NULL/);
});
test('channel membership accepts either department or unexpired individual grant', () => {
  const source = read('security.js');
  assert.match(source, /JOIN user_departments ud ON ud.department_id = cdg.department_id/);
  assert.match(source, /dg.expires_at IS NULL OR dg.expires_at > NOW\(\)/);
});
test('both channel discovery endpoints suppress banned channels and honor new grants', () => {
  const source = read('routes/channels.js');
  assert.equal((source.match(/NOT EXISTS \(SELECT 1 FROM channel_bans b WHERE b.channel_id = c.id AND b.user_id = \$1\)/g) || []).length, 2);
  assert.equal((source.match(/channel_direct_grants dg WHERE dg.channel_id = c.id/g) || []).length, 2);
});
