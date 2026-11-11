const test = require('node:test');
const assert = require('node:assert/strict');
const { findMentionedUsers } = require('../src/mentions');

const members = [
  { id: 1, username: 'ann' },
  { id: 2, username: 'ann marie' },
  { id: 3, username: 'bob.smith' },
  { id: 4, username: 'Carol' },
];
const ids = (content) => findMentionedUsers(content, members).map((user) => user.id).sort();

test('finds simple, dotted, and case-insensitive mentions', () => {
  assert.deepEqual(ids('hi @ann, meet @bob.smith and @CAROL!'), [1, 3, 4]);
});

test('prefers the longest username and does not double count its prefix', () => {
  assert.deepEqual(ids('thanks @ann marie'), [2]);
  assert.deepEqual(ids('@ann marie and also @ann'), [1, 2]);
});

test('ignores emails, partial names, and text without mentions', () => {
  assert.deepEqual(ids('mail me at x@ann.example'), []);
  assert.deepEqual(ids('@annabel is someone else'), []);
  assert.deepEqual(ids('no mentions here'), []);
  assert.deepEqual(findMentionedUsers(null, members), []);
});
