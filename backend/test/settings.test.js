const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
process.env.JWT_SECRET ||= 'settings-test-secret';

const {
  mergeNotificationPrefs,
  isSingleEmojiOrEmpty,
  NOTIFICATION_DEFAULTS,
  normalizeSidebarLayout,
  normalizeWorkspaceSidebarLayout,
} = require('../src/routes/settings');
const { normalizeLinkUrl } = require('../src/routes/channelLinks');

test('notification preferences fall back to defaults and ignore junk in storage', () => {
  assert.deepEqual(mergeNotificationPrefs(undefined), { ...NOTIFICATION_DEFAULTS });
  assert.deepEqual(
    mergeNotificationPrefs({ mentions: false, reactions: 'yes', unknown: true }),
    { ...NOTIFICATION_DEFAULTS, mentions: false }
  );
});

test('notification preference changes are merged over stored values', () => {
  const merged = mergeNotificationPrefs({ mentions: false }, { channelMessages: true, desktop: false });
  assert.equal(merged.mentions, false);
  assert.equal(merged.channelMessages, true);
  assert.equal(merged.desktop, false);
  assert.equal(merged.replies, true);
});

test('invalid notification changes are rejected', () => {
  assert.throws(() => mergeNotificationPrefs({}, { mentions: 'no' }), /true or false/);
  assert.throws(() => mergeNotificationPrefs({}, { everything: true }), /Unknown notification setting/);
  assert.throws(() => mergeNotificationPrefs({}, [true]), /object/);
});

test('status emoji accepts one emoji or nothing', () => {
  for (const value of ['', '🌴', '🇵🇭', '👨‍👩‍👧‍👦']) assert.equal(isSingleEmojiOrEmpty(value), true, value);
  for (const value of ['ab', '🌴🌴', 'x', 5, null]) assert.equal(isSingleEmojiOrEmpty(value), false, String(value));
});

test('sidebar layout is normalised and rejects duplicates and junk', () => {
  assert.deepEqual(
    normalizeSidebarLayout({ sections: [{ id: 'a1', name: ' Projects ', channelIds: ['3', 4], collapsed: 1 }] }),
    { sections: [{ id: 'a1', name: 'Projects', channelIds: [3, 4], collapsed: true }], workspaceCollapsed: [] }
  );
  assert.throws(() => normalizeSidebarLayout({}), /list of sections/);
  assert.throws(() => normalizeSidebarLayout({ sections: [{ id: 'a', name: '', channelIds: [] }] }), /1 to 40/);
  assert.throws(() => normalizeSidebarLayout({ sections: [
    { id: 'a', name: 'A', channelIds: [1] }, { id: 'b', name: 'B', channelIds: [1] },
  ] }), /only be in one section/);
  assert.throws(() => normalizeSidebarLayout({ sections: [
    { id: 'a', name: 'A', channelIds: [] }, { id: 'a', name: 'B', channelIds: [] },
  ] }), /unique/);
  assert.throws(() => normalizeSidebarLayout({ sections: [{ id: 'a', name: 'A', channelIds: [-1] }] }), /positive/);
  assert.deepEqual(
    normalizeSidebarLayout({ sections: [], workspaceCollapsed: ['locked', 'locked', '../bad'] }),
    { sections: [], workspaceCollapsed: ['locked'] }
  );
  assert.deepEqual(
    normalizeWorkspaceSidebarLayout({ sections: [{ id: 'team', name: ' Team ', channelIds: [2], collapsed: true }] }),
    { sections: [{ id: 'team', name: 'Team', channelIds: [2] }] }
  );
});

test('channel links accept only absolute http(s) addresses', () => {
  assert.equal(normalizeLinkUrl(' https://example.com/docs?a=1 '), 'https://example.com/docs?a=1');
  assert.equal(normalizeLinkUrl('http://intranet.local'), 'http://intranet.local/');
  for (const bad of ['javascript:alert(1)', 'file:///c:/x', 'example.com', '', null, 'data:text/html,x']) {
    assert.equal(normalizeLinkUrl(bad), null, String(bad));
  }
});
