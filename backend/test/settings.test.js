const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
process.env.JWT_SECRET ||= 'settings-test-secret';

const {
  mergeNotificationPrefs,
  isSingleEmojiOrEmpty,
  NOTIFICATION_DEFAULTS,
} = require('../src/routes/settings');

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
