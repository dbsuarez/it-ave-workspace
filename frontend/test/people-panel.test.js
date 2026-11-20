// The members panel on the right of a channel or forum (Online and Offline, each collapsible, with a search): merging, grouping and markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const { peoplePanelMerge, peoplePanelGroups, peoplePanelHtml } = require('../src/features/people-panel');

const nameOf = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;
// what GET /api/channels/:id/members gives: people in this channel (no bots, no built-in admin)
const members = [
  { id: 2, username: 'ann', firstName: 'Ann', lastName: 'Cruz', status: 'offline', avatarColor: '#111111' },
  { id: 3, username: 'ben', firstName: 'Ben', lastName: 'Reyes', status: 'offline', avatarColor: '#222222' },
  { id: 4, username: 'cy', firstName: 'Cy', lastName: 'Dee', status: 'away', avatarColor: '#333333' },
  { id: 9, username: 'me', firstName: 'Me', lastName: 'Self', status: 'offline', avatarColor: '#444444' },
];
// the app's loaded people list knows the live status and the status line
const users = [
  { id: 2, status: 'online', statusText: 'Lunch <b>now</b>', statusEmoji: '\u{1F354}', photoVersion: 5, accountType: 'member' },
  { id: 3, status: 'offline', accountType: 'member' },
];
const me = { id: 9, status: 'online', statusText: '', statusEmoji: '' };

test('members get their live status and status line from the loaded people, and you show as online', () => {
  const merged = peoplePanelMerge({ members, users, me });
  assert.equal(merged.find((m) => m.id === 2).status, 'online');
  assert.equal(merged.find((m) => m.id === 2).statusEmoji, '\u{1F354}');
  assert.equal(merged.find((m) => m.id === 2).photoVersion, 5);
  assert.equal(merged.find((m) => m.id === 3).status, 'offline');
  assert.equal(merged.find((m) => m.id === 4).status, 'away', 'someone not in the loaded list keeps the status the channel list gave');
  assert.equal(merged.find((m) => m.id === 9).status, 'online', 'you are online');
  assert.equal(merged.find((m) => m.id === 2).firstName, 'Ann');
});

test('only the people in this channel are grouped: Online (online or away) and Offline, alphabetical, you included', () => {
  const groups = peoplePanelGroups({ members: peoplePanelMerge({ members, users, me }), query: '', nameOf });
  assert.deepEqual(groups.online.map((u) => u.id), [2, 4, 9]);
  assert.deepEqual(groups.offline.map((u) => u.id), [3]);
});

test('the search narrows both groups to matching names', () => {
  const groups = peoplePanelGroups({ members: peoplePanelMerge({ members, users, me }), query: 'be', nameOf });
  assert.deepEqual(groups.online, []);
  assert.deepEqual(groups.offline.map((u) => u.id), [3]);
});

test('the panel shows each group with its count and a fold button, rows with name and status, and nothing unsafe', () => {
  const groups = peoplePanelGroups({ members: peoplePanelMerge({ members, users, me }), query: '', nameOf });
  const html = peoplePanelHtml({ groups, collapsed: { online: false, offline: false }, query: '', nameOf, title: 'Members of #general' });
  assert.match(html, /Members of #general/);
  assert.match(html, /data-pp-group="online"[^>]*aria-expanded="true"[\s\S]*Online[\s\S]*3/);
  assert.match(html, /data-pp-group="offline"[\s\S]*Offline[\s\S]*1/);
  assert.match(html, /data-pp-user="2"/);
  assert.match(html, /Ann Cruz/);
  assert.match(html, /Lunch &lt;b&gt;now&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>now/);
  assert.match(html, /\u{1F354}/u);
  assert.match(html, /pp-row offline[\s\S]*Ben Reyes/, 'offline people are dimmed');
  assert.equal(/Admin|Owner|Moderator/i.test(html), false, 'role names are never printed');
});

test('a folded group hides its people but keeps its heading and count', () => {
  const groups = peoplePanelGroups({ members: peoplePanelMerge({ members, users, me }), query: '', nameOf });
  const html = peoplePanelHtml({ groups, collapsed: { online: true, offline: false }, query: '', nameOf, title: 'Members' });
  assert.match(html, /data-pp-group="online"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(html, /Ann Cruz/);
  assert.match(html, /Ben Reyes/);
});

test('nothing to show says so, and the search box keeps what was typed (escaped)', () => {
  const none = peoplePanelHtml({ groups: { online: [], offline: [] }, collapsed: {}, query: '<x>', nameOf, title: 'Members' });
  assert.match(none, /No one matches/);
  assert.match(none, /value="&lt;x&gt;"/);
  const empty = peoplePanelHtml({ groups: { online: [], offline: [] }, collapsed: {}, query: '', nameOf, title: '<Members>' });
  assert.match(empty, /No members to show/);
  assert.match(empty, /&lt;Members&gt;/);
});
