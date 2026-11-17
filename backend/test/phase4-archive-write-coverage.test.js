const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = (name) => fs.readFileSync(path.join(__dirname, '../src/routes', name), 'utf8');

test('list edits, creation and copy destination are archive guarded', () => {
  const list = src('lists.js');
  assert.match(list, /if \(write\) \{[\s\S]*?ensureChannelNotArchived\(query, list\.channel_id\)/);
  assert.match(list, /await ensureChannelNotArchived\(query, channelId\);/);
  assert.match(list, /if \(channelId !== source\.channel_id\)[\s\S]*?await ensureChannelNotArchived\(query, channelId\)/);
  for (const method of ['patch', 'delete']) assert.match(list, new RegExp(`router\\.${method}\\('\\/:listId`));
});

test('pin and reaction mutations verify archive state after membership', () => {
  const messages = src('messages.js');
  const pin = messages.split("router.patch('/:messageId/pin'")[1].split('// Reactors for a single message')[0];
  const reaction = messages.split("router.post('/:messageId/reactions'")[1];
  for (const route of [pin, reaction]) {
    assert.ok(route);
    assert.match(route, /ensureChannelMembership\(query, req\.user\.userId, channelId\);\s*await ensureChannelNotArchived\(query, channelId\)/);
  }
});
