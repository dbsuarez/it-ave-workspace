const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

test('shared standalone canvas roles revalidate each channel grant against current membership', () => {
  const security = source('security.js');
  assert.match(security, /SELECT g\.role, g\.channel_id FROM canvas_channel_grants/);
  assert.match(security, /await ensureChannelMembership\(query, userId, grant\.channel_id\)/);
  assert.match(security, /throw err; \/\/ fail closed on database errors/);
});

test('channel activity and mentions are filtered at delivery time', () => {
  const chat = source('sockets/chat.js');
  assert.match(chat, /await mayReceiveChannelActivity\(query, recipient\.id, messageData\.channelId\)/);
  assert.match(chat, /await mayReceiveChannelActivity\(query, user\.id, messageData\.channelId\)/);
  assert.match(chat, /await mayReceiveChannelActivity\(query, parentAuthorId, messageData\.channelId\)/);
  assert.match(chat, /await ensureChannelMembership\(query, userId, channelId\)/);
});

// Prevent the grant-alternative group from swallowing the ban exclusion or
// producing malformed SQL (regression from Patch 14).
test('recipient discovery closes its grant group before applying ban exclusion', () => {
  const chat = source('sockets/chat.js');
  assert.match(chat, /AND co\.subject_id = u\.department_id AND 'view_channel' = ANY\(co\.allow\)\)\)\s+AND NOT EXISTS/);
});
