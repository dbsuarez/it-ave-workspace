const test = require('node:test');
const assert = require('node:assert/strict');
const { forumTopicListHtml, forumTopicHeaderHtml, FORUM_BADGES } = require('../src/features/forum-view');

const topic = (overrides = {}) => ({
  id: 5, title: 'Printer on floor 3', authorUsername: 'ann', replyCount: 2, lastActivityText: '5 min ago',
  pinnedAt: null, lockedAt: null, archivedAt: null, ...overrides,
});
const order = (html) => [...html.matchAll(/data-topic-open="(\d+)"/g)].map((m) => Number(m[1]));

test('the list shows title, author, reply count and the relative activity text', () => {
  const html = forumTopicListHtml([topic()], { canModerate: false });
  assert.match(html, /data-topic-open="5"/);
  assert.match(html, /Printer on floor 3/);
  assert.match(html, /ann/);
  assert.match(html, /2 replies/);
  assert.match(html, /5 min ago/);
});

test('one reply and no replies read naturally', () => {
  assert.match(forumTopicListHtml([topic({ replyCount: 1 })]), /1 reply/);
  assert.match(forumTopicListHtml([topic({ replyCount: 0 })]), /No replies yet/);
});

test('pinned topics come first with a Pinned badge; Locked and Archived get their own badges', () => {
  const html = forumTopicListHtml([
    topic({ id: 1, title: 'plain' }),
    topic({ id: 2, title: 'stuck', pinnedAt: '2026-01-01T00:00:00Z' }),
    topic({ id: 3, title: 'closed', lockedAt: '2026-01-01T00:00:00Z' }),
    topic({ id: 4, title: 'old', archivedAt: '2026-01-01T00:00:00Z' }),
  ]);
  assert.deepEqual(order(html), [2, 1, 3, 4]);
  assert.equal((html.match(new RegExp(FORUM_BADGES.pinned, 'g')) || []).length, 1);
  assert.match(html, new RegExp(FORUM_BADGES.locked));
  assert.match(html, new RegExp(FORUM_BADGES.archived));
});

test('an empty list shows a message, and a different one for the archive', () => {
  assert.match(forumTopicListHtml([], {}), /No topics yet/);
  assert.match(forumTopicListHtml([], { archived: true }), /No archived topics/);
  assert.doesNotMatch(forumTopicListHtml([], {}), /data-topic-open/);
});

test('moderation buttons appear only for moderators, and say what they will do', () => {
  const plain = forumTopicListHtml([topic()], { canModerate: false });
  assert.doesNotMatch(plain, /data-topic-(pin|lock|archive|delete)/);
  const mod = forumTopicListHtml([topic(), topic({ id: 6, pinnedAt: 'x', lockedAt: 'x', archivedAt: 'x' })], { canModerate: true });
  assert.match(mod, /data-topic-pin="5" data-set="true"/);
  assert.match(mod, /data-topic-lock="5" data-set="true"/);
  assert.match(mod, /data-topic-archive="5" data-set="true"/);
  assert.match(mod, /data-topic-delete="5"/);
  assert.match(mod, /data-topic-pin="6" data-set="false"/);
  assert.match(mod, /data-topic-lock="6" data-set="false"/);
  assert.match(mod, /data-topic-archive="6" data-set="false"/);
});

test('every value is escaped', () => {
  const html = forumTopicListHtml([topic({ title: '<img src=x onerror=alert(1)>', authorUsername: '<b>x</b>', lastActivityText: '"><script>' })], { canModerate: true });
  assert.doesNotMatch(html, /<img|<b>|<script>/);
  assert.match(html, /&lt;img/);
  const header = forumTopicHeaderHtml(topic({ title: '<script>alert(1)</script>', authorUsername: '<i>' }), { canModerate: true });
  assert.doesNotMatch(header, /<script>|<i>/);
});

test('the header has a way back, the title, and moderator controls only for moderators', () => {
  const header = forumTopicHeaderHtml(topic(), { canModerate: false });
  assert.match(header, /data-topic-back/);
  assert.match(header, /Printer on floor 3/);
  assert.doesNotMatch(header, /data-topic-(pin|lock|archive|delete)/);
  assert.match(forumTopicHeaderHtml(topic(), { canModerate: true }), /data-topic-lock="5"/);
});

test('a locked topic says replies are off; an archived one says it is read-only; an open one says nothing', () => {
  assert.match(forumTopicHeaderHtml(topic({ lockedAt: 'x' })), /This topic is locked/);
  assert.match(forumTopicHeaderHtml(topic({ archivedAt: 'x' })), /This topic is archived/);
  assert.doesNotMatch(forumTopicHeaderHtml(topic()), /forum-notice/);
});

test('relative times: just now, minutes, hours, days, then a date', () => {
  const { forumRelativeTime } = require('../src/features/forum-view');
  const now = Date.parse('2026-11-18T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(forumRelativeTime(ago(20 * 1000), now), 'just now');
  assert.equal(forumRelativeTime(ago(5 * 60 * 1000), now), '5 min ago');
  assert.equal(forumRelativeTime(ago(3 * 3600 * 1000), now), '3 h ago');
  assert.equal(forumRelativeTime(ago(2 * 86400 * 1000), now), '2 d ago');
  assert.match(forumRelativeTime(ago(40 * 86400 * 1000), now), /2026/);
  assert.equal(forumRelativeTime(null, now), '');
  assert.equal(forumRelativeTime('not a date', now), '');
  assert.equal(forumRelativeTime(new Date(now + 60000).toISOString(), now), 'just now', 'a clock a little ahead is still just now');
});
