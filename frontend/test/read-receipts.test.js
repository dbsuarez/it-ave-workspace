const test = require('node:test');
const assert = require('node:assert/strict');
const { readReceiptsSummary } = require('../src/features/read-receipts');

const people = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Person ${i + 1}` }));

test('up to four people show as they are, with nothing to expand', () => {
  const summary = readReceiptsSummary(people(4), false);
  assert.equal(summary.visible.length, 4);
  assert.equal(summary.hidden, 0);
  assert.equal(summary.canToggle, false);
  assert.equal(summary.text, 'Person 1, Person 2, Person 3, Person 4');
});

test('more than four are cut to four with a count of the rest, which can be expanded', () => {
  const summary = readReceiptsSummary(people(5), false);
  assert.equal(summary.visible.length, 4);
  assert.equal(summary.hidden, 1);
  assert.equal(summary.canToggle, true);
  assert.equal(summary.expanded, false);
});

test('expanded, everyone shows and nothing is hidden, but it can be folded back', () => {
  const summary = readReceiptsSummary(people(9), true);
  assert.equal(summary.visible.length, 9);
  assert.equal(summary.hidden, 0);
  assert.equal(summary.canToggle, true);
  assert.equal(summary.expanded, true);
  assert.match(summary.text, /Person 9$/);
});

test('a person with no name shows their username, and an empty list is empty', () => {
  assert.equal(readReceiptsSummary([{ id: 1, username: 'ann' }], false).text, 'ann');
  const none = readReceiptsSummary([], false);
  assert.deepEqual([none.visible.length, none.hidden, none.canToggle, none.text], [0, 0, false, '']);
});

test('opening on a list that is short again does not stay expanded', () => {
  assert.equal(readReceiptsSummary(people(3), true).canToggle, false);
});
