// Showing a person: their full name, the username only when there is no name. Pure lookup; the app passes in who it knows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDisplayName } = require('../src/features/display-name');

const people = [
  { id: 2, username: 'jomar.deguzman', firstName: 'Jomar', middleName: 'R.', lastName: 'De Guzman' },
  { id: 3, username: 'sam', firstName: '', lastName: '' },
  { id: 4, username: 'Mixed.Case', firstName: 'Mia', lastName: 'Case' },
];
const me = { id: 1, username: 'dante', firstName: 'Dante', middleName: 'B.', lastName: 'Suarez Jr.' };

test('a person is shown by full name, found by username (any case) or by id', () => {
  assert.equal(resolveDisplayName(people, me, 'jomar.deguzman'), 'Jomar R. De Guzman');
  assert.equal(resolveDisplayName(people, me, 'mixed.case'), 'Mia Case');
  assert.equal(resolveDisplayName(people, me, { id: 2 }), 'Jomar R. De Guzman');
  assert.equal(resolveDisplayName(people, me, { userId: 2, username: 'whatever' }), 'Jomar R. De Guzman');
});

test('the signed-in person is found too', () => {
  assert.equal(resolveDisplayName(people, me, 'dante'), 'Dante B. Suarez Jr.');
  assert.equal(resolveDisplayName(people, me, { id: 1 }), 'Dante B. Suarez Jr.');
});

test('the username is only the fallback: nobody with a name, an unknown person, or someone who has not filled their name in', () => {
  assert.equal(resolveDisplayName(people, me, 'sam'), 'sam');
  assert.equal(resolveDisplayName(people, me, 'stranger'), 'stranger');
  assert.equal(resolveDisplayName(people, me, { id: 99, username: 'gone.user' }), 'gone.user');
  assert.equal(resolveDisplayName(people, me, null), '');
  assert.equal(resolveDisplayName(people, me, undefined, 'Unknown'), 'Unknown');
  assert.equal(resolveDisplayName(undefined, undefined, 'x'), 'x');
});

test('a server that already sends the name is used as it is', () => {
  assert.equal(resolveDisplayName(people, me, { username: 'jomar.deguzman', name: 'Jomar De Guzman' }), 'Jomar De Guzman');
  assert.equal(resolveDisplayName(people, me, { username: 'zed', firstName: 'Zed', lastName: 'Zee' }), 'Zed Zee');
});
