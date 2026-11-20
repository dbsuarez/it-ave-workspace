// The people panel on the right (Online and Offline, each collapsible, with a search): grouping and markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const { peoplePanelGroups, peoplePanelHtml } = require('../src/features/people-panel');

const users = [
  { id: 2, username: 'ann', firstName: 'Ann', lastName: 'Cruz', accountType: 'member', status: 'online', statusText: 'Lunch <b>now</b>', statusEmoji: '\u{1F354}' },
  { id: 3, username: 'ben', firstName: 'Ben', lastName: 'Reyes', accountType: 'member', status: 'offline' },
  { id: 4, username: 'cy', firstName: 'Cy', lastName: 'Dee', accountType: 'member', status: 'away' },
  { id: 5, username: 'gus', firstName: 'Gus', lastName: 'Tie', accountType: 'guest', status: 'online' },
  { id: 6, username: 'botty', firstName: '', lastName: '', accountType: 'bot', status: 'online' },
  { id: 9, username: 'me', firstName: 'Me', lastName: 'Self', accountType: 'member', status: 'online' },
];
const nameOf = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;

test('employees are grouped Online (online or away) and Offline, alphabetical, without you, guests or bots', () => {
  const groups = peoplePanelGroups({ users, meId: 9, query: '', nameOf });
  assert.deepEqual(groups.online.map((u) => u.id), [2, 4]);
  assert.deepEqual(groups.offline.map((u) => u.id), [3]);
});

test('the search narrows both groups to matching names', () => {
  const groups = peoplePanelGroups({ users, meId: 9, query: 'be', nameOf });
  assert.deepEqual(groups.online, []);
  assert.deepEqual(groups.offline.map((u) => u.id), [3]);
});

test('the panel shows each group with its count and a fold button, rows with name and status, and nothing unsafe', () => {
  const groups = peoplePanelGroups({ users, meId: 9, query: '', nameOf });
  const html = peoplePanelHtml({ groups, collapsed: { online: false, offline: false }, query: '', nameOf });
  assert.match(html, /data-pp-group="online"[^>]*aria-expanded="true"[\s\S]*Online[\s\S]*2/);
  assert.match(html, /data-pp-group="offline"[\s\S]*Offline[\s\S]*1/);
  assert.match(html, /data-pp-user="2"/);
  assert.match(html, /Ann Cruz/);
  assert.match(html, /Lunch &lt;b&gt;now&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>now/);
  assert.match(html, /\u{1F354}/u);
  assert.match(html, /pp-row offline[\s\S]*Ben Reyes/, 'offline people are dimmed');
});

test('a folded group hides its people but keeps its heading and count', () => {
  const groups = peoplePanelGroups({ users, meId: 9, query: '', nameOf });
  const html = peoplePanelHtml({ groups, collapsed: { online: true, offline: false }, query: '', nameOf });
  assert.match(html, /data-pp-group="online"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(html, /Ann Cruz/);
  assert.match(html, /Ben Reyes/);
});

test('nothing to show says so, and the search box keeps what was typed (escaped)', () => {
  const none = peoplePanelHtml({ groups: { online: [], offline: [] }, collapsed: {}, query: '<x>', nameOf });
  assert.match(none, /No one matches/);
  assert.match(none, /value="&lt;x&gt;"/);
  const empty = peoplePanelHtml({ groups: { online: [], offline: [] }, collapsed: {}, query: '', nameOf });
  assert.match(empty, /No coworkers yet/);
});
