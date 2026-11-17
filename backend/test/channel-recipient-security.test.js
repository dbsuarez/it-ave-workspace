const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/sockets/chat.js'), 'utf8');
test('channel activity candidates include direct and multiple department grants', () => {
  const section = source.split('async function channelRecipientCandidates')[1].split('async function notifyMessageActivity')[0];
  assert.match(section, /channel_department_grants/);
  assert.match(section, /user_departments/);
  assert.match(section, /channel_direct_grants/);
  assert.match(section, /expires_at > NOW\(\)/);
  assert.match(section, /channel_bans/);
});
test('mentions are restricted to channel candidates and revalidated', () => {
  assert.match(source, /candidateIds\.has\(Number\(user\.id\)\)/);
  assert.match(source, /mayReceiveChannelActivity\(query, user\.id, messageData\.channelId\)/);
});
test('expiration sweeper is started from socket initialization', () => {
  assert.match(source, /startChannelExpirySweep\(io,/);
});
