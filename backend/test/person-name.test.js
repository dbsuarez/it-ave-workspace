// How the server names a person in text it builds itself: the full name, the username only as the fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fullName, displayName, FULL_NAME_SQL } = require('../src/personName');

test('a full name joins first, middle and last, skipping the empty ones', () => {
  assert.equal(fullName({ first_name: 'Jomar', middle_name: 'R.', last_name: 'De Guzman' }), 'Jomar R. De Guzman');
  assert.equal(fullName({ firstName: ' Mia ', lastName: 'Case' }), 'Mia Case');
  assert.equal(fullName({ first_name: '', middle_name: null, last_name: '  ' }), '');
  assert.equal(fullName(null), '');
});

test('the username is the fallback when there is no name', () => {
  assert.equal(displayName({ username: 'sam', first_name: '' }), 'sam');
  assert.equal(displayName({ username: 'jomar', first_name: 'Jomar', last_name: 'De Guzman' }), 'Jomar De Guzman');
  assert.equal(displayName({}), '');
});

test('the SQL form of a name takes the table alias', () => {
  const sql = FULL_NAME_SQL('u');
  assert.match(sql, /u\.first_name/);
  assert.match(sql, /u\.middle_name/);
  assert.match(sql, /u\.last_name/);
  assert.match(FULL_NAME_SQL('other_user'), /other_user\.last_name/);
});
