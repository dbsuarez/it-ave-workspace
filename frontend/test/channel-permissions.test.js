// The Permissions card on a channel: setting one permission for every row at once (the "set all" box in a column header).
const test = require('node:test');
const assert = require('node:assert/strict');
const { permApplyValue, permBulkSummary, permAppliesTo, composerLockReason, attachBlockedReason, reactionsBlockedReason, composerMode, commandsOnlyAllows } = require('../src/features/channel-permissions');

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

test('the composer is locked up front, with a reason, when the person may not send messages in the channel', () => {
  assert.match(composerLockReason({ sendMessages: false, attachFiles: true, addReactions: true }), /permission to send messages/);
  assert.equal(composerLockReason({ sendMessages: true, attachFiles: false, addReactions: true }), null, 'only attaching is denied: they can still type');
  assert.equal(composerLockReason(null), null, 'nothing is known yet: do not lock');
  assert.equal(composerLockReason(undefined), null);
});

test('attaching and reacting each have their own reason, and nothing is blocked while unknown', () => {
  assert.match(attachBlockedReason({ sendMessages: true, attachFiles: false, addReactions: true }), /attach files/);
  assert.equal(attachBlockedReason({ sendMessages: true, attachFiles: true, addReactions: true }), null);
  assert.equal(attachBlockedReason(null), null);
  assert.match(reactionsBlockedReason({ sendMessages: true, attachFiles: true, addReactions: false }), /reactions/);
  assert.equal(reactionsBlockedReason({ sendMessages: true, attachFiles: true, addReactions: true }), null);
  assert.equal(reactionsBlockedReason(null), null);
});

test('where sending is denied the composer still takes slash commands; a locked topic is locked completely', () => {
  const denied = { sendMessages: false, attachFiles: true, addReactions: true };
  assert.deepEqual(composerMode(denied, null), { mode: 'commands', reason: "You don't have permission to send messages in this channel" });
  assert.deepEqual(composerMode(null, null), { mode: 'open', reason: null });
  assert.deepEqual(composerMode({ sendMessages: true }, null), { mode: 'open', reason: null });
  assert.deepEqual(composerMode(denied, 'This topic is locked'), { mode: 'locked', reason: 'This topic is locked' });
  assert.deepEqual(composerMode(null, 'This topic is archived'), { mode: 'locked', reason: 'This topic is archived' });
});

test('in commands-only mode only a command (starting with a single slash) may be typed', () => {
  assert.equal(commandsOnlyAllows('/leave'), true);
  assert.equal(commandsOnlyAllows('/'), true);
  assert.equal(commandsOnlyAllows(''), true, 'an empty box is fine');
  assert.equal(commandsOnlyAllows('hello'), false);
  assert.equal(commandsOnlyAllows('//not a command'), false, 'a literal slash message is a message');
  assert.equal(commandsOnlyAllows(' /leave'), true, 'leading spaces are ignored');
});
