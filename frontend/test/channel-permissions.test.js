// The Permissions card on a channel: setting one permission for every row at once (the "set all" box in a column header).
const test = require('node:test');
const assert = require('node:assert/strict');
const { permApplyValue, permBulkSummary, permAppliesTo } = require('../src/features/channel-permissions');

test('one permission can be set to inherit, allow or deny without touching the others', () => {
  const item = { allow: ['send', 'react'], deny: ['attach'] };
  assert.deepEqual(permApplyValue(item, 'send', 'deny'), { allow: ['react'], deny: ['attach', 'send'] });
  assert.deepEqual(permApplyValue(item, 'attach', 'allow'), { allow: ['send', 'react', 'attach'], deny: [] });
  assert.deepEqual(permApplyValue(item, 'send', 'inherit'), { allow: ['react'], deny: ['attach'] });
  assert.deepEqual(permApplyValue({ allow: [], deny: [] }, 'view', 'allow'), { allow: ['view'], deny: [] });
  assert.deepEqual(item, { allow: ['send', 'react'], deny: ['attach'] }, 'the row itself is not changed');
});

test('setting a permission that is already that value twice does not duplicate it', () => {
  assert.deepEqual(permApplyValue({ allow: ['send'], deny: [] }, 'send', 'allow'), { allow: ['send'], deny: [] });
  assert.deepEqual(permApplyValue({ allow: [], deny: ['send'] }, 'send', 'deny'), { allow: [], deny: ['send'] });
});

test('the confirmation says what will be set, for how many rows', () => {
  assert.match(permBulkSummary('Send messages', 'deny', 12), /Send messages/);
  assert.match(permBulkSummary('Send messages', 'deny', 12), /Deny/);
  assert.match(permBulkSummary('Send messages', 'deny', 12), /12 rows/);
  assert.match(permBulkSummary('Attach files', 'inherit', 1), /1 row\b/);
  assert.match(permBulkSummary('Attach files', 'inherit', 1), /Inherit/);
});

test('a department can only be given access to see the channel, never the action permissions', () => {
  assert.equal(permAppliesTo('department', 'view_channel'), true);
  assert.equal(permAppliesTo('department', 'send_messages'), false);
  assert.equal(permAppliesTo('role', 'send_messages'), true);
  assert.equal(permAppliesTo('user', 'attach_files'), true);
});
