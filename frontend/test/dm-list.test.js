// The DM list: only people you have talked with, latest conversation first; the search finds employees to start a new one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dmConversationUsers, dmBumpPartner, dmSearchEmployees } = require('../src/features/dm-list');

const users = [
  { id: 2, username: 'ann.cruz', firstName: 'Ann', lastName: 'Cruz', accountType: 'member', status: 'online' },
  { id: 3, username: 'ben', firstName: 'Ben', lastName: 'Reyes', accountType: 'member', status: 'offline' },
  { id: 4, username: 'cy', firstName: '', lastName: '', accountType: 'member', status: 'away' },
  { id: 5, username: 'guestie', firstName: 'Gus', lastName: 'Tie', accountType: 'guest', status: 'offline' },
  { id: 6, username: 'botty', firstName: '', lastName: '', accountType: 'bot', status: 'offline' },
  { id: 9, username: 'me', firstName: 'Me', lastName: 'Self', accountType: 'member', status: 'online' },
];
const nameOf = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;

test('the list is the people you talked with, in the order of the latest message, skipping anyone no longer in the directory', () => {
  const partners = [{ userId: 3, lastAt: 'b' }, { userId: 77, lastAt: 'x' }, { userId: 2, lastAt: 'a' }];
  assert.deepEqual(dmConversationUsers({ users, partners, openId: null, meId: 9 }).map((u) => u.id), [3, 2]);
  assert.deepEqual(dmConversationUsers({ users, partners: [], openId: null, meId: 9 }), []);
});

test('a chat you just opened but have not written in yet shows at the top until there is a message', () => {
  const partners = [{ userId: 3, lastAt: 'b' }];
  assert.deepEqual(dmConversationUsers({ users, partners, openId: 2, meId: 9 }).map((u) => u.id), [2, 3]);
  assert.deepEqual(dmConversationUsers({ users, partners, openId: 3, meId: 9 }).map((u) => u.id), [3], 'already there: not repeated');
  assert.deepEqual(dmConversationUsers({ users, partners, openId: 9, meId: 9 }).map((u) => u.id), [3], 'never yourself');
  assert.deepEqual(dmConversationUsers({ users, partners, openId: 404, meId: 9 }).map((u) => u.id), [3]);
});

test('a new message moves that person to the top, and starts the list entry if there was none', () => {
  const partners = [{ userId: 3, lastAt: 'b' }, { userId: 2, lastAt: 'a' }];
  assert.deepEqual(dmBumpPartner(partners, 2, 'c'), [{ userId: 2, lastAt: 'c' }, { userId: 3, lastAt: 'b' }]);
  assert.deepEqual(dmBumpPartner(partners, 4, 'c').map((p) => p.userId), [4, 3, 2]);
  assert.deepEqual(partners.map((p) => p.userId), [3, 2], 'the old list is not changed');
});

test('the search finds employees only, by full name or username, never yourself, guests or bots', () => {
  const ids = (query) => dmSearchEmployees({ users, query, meId: 9, nameOf }).map((u) => u.id);
  assert.deepEqual(ids('ann'), [2]);
  assert.deepEqual(ids('CRUZ'), [2], 'any case');
  assert.deepEqual(ids('ann cr'), [2], 'every word must match');
  assert.deepEqual(ids('reyes'), [3]);
  assert.deepEqual(ids('cy'), [4], 'the username when there is no name');
  assert.deepEqual(ids('gus'), [], 'a guest is not an employee');
  assert.deepEqual(ids('botty'), [], 'nor a bot');
  assert.deepEqual(ids('self'), [], 'nor you');
  assert.deepEqual(ids('   '), [], 'an empty search finds nothing');
  assert.deepEqual(ids(''), []);
  assert.deepEqual(dmSearchEmployees({ users, query: 'n', meId: 9, nameOf }).map((u) => u.id), [2, 3], 'alphabetical by name');
});
