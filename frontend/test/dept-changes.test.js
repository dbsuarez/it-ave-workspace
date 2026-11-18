const test = require('node:test');
const assert = require('node:assert/strict');
const { departmentChanges, employeeOptions, headIdFromInput } = require('../src/features/dept-changes');

const current = [{ id: 1, name: 'MIS', headId: 5 }, { id: 2, name: 'Legal', headId: null }, { id: 3, name: 'HR', headId: 7 }];

test('nothing edited means nothing to save', () => {
  assert.deepEqual(departmentChanges(current, current.map((d) => ({ ...d }))), { changes: [], blank: [], invalid: [] });
});

test('only the departments that differ are returned, with their new name and head', () => {
  const edited = [{ id: 1, name: 'MIS', headId: 9 }, { id: 2, name: 'Legal', headId: null }, { id: 3, name: 'Human Resource', headId: 7 }];
  assert.deepEqual(departmentChanges(current, edited).changes, [{ id: 1, name: 'MIS', headId: 9 }, { id: 3, name: 'Human Resource', headId: 7 }]);
});

test('setting a head and clearing one both count; "" and null are the same "no head"', () => {
  const edited = [{ id: 1, name: 'MIS', headId: null }, { id: 2, name: 'Legal', headId: 4 }, { id: 3, name: 'HR', headId: 7 }];
  assert.deepEqual(departmentChanges(current, edited).changes.map((c) => [c.id, c.headId]), [[1, null], [2, 4]]);
  assert.deepEqual(departmentChanges(current, [{ id: 2, name: 'Legal', headId: '' }]).changes, [], 'empty string is no head');
});

test('spaces around a name are ignored; a blank name is reported, not saved', () => {
  assert.deepEqual(departmentChanges(current, [{ id: 1, name: '  MIS  ', headId: 5 }]).changes, []);
  const result = departmentChanges(current, [{ id: 1, name: '   ', headId: 5 }, { id: 3, name: 'HR', headId: 8 }]);
  assert.deepEqual(result.blank, [1]);
  assert.deepEqual(result.changes.map((c) => c.id), [3]);
});

test('a row with an id the list does not know is ignored', () => {
  assert.deepEqual(departmentChanges(current, [{ id: 99, name: 'Ghost', headId: 1 }]), { changes: [], blank: [], invalid: [] });
});

const people = [
  { id: 3, name: 'carlos Fule', username: 'carlos.fule' },
  { id: 1, name: 'Angelo Abadilla', username: 'angelo.abadilla' },
  { id: 2, name: 'Dante B. Suarez Jr.', username: 'dante.suarez' },
  { id: 4, name: 'Angelo Abadilla', username: 'angelo.second' },
];

test('the employee list is alphabetical, ignoring case, and a repeated name is told apart by username', () => {
  const options = employeeOptions(people);
  assert.deepEqual(options.map((o) => o.label), [
    'Angelo Abadilla (angelo.abadilla)', 'Angelo Abadilla (angelo.second)', 'carlos Fule (carlos.fule)', 'Dante B. Suarez Jr. (dante.suarez)',
  ]);
  assert.deepEqual(options.map((o) => o.id), [1, 4, 3, 2]);
});

test('typed text becomes a head: an exact choice gives its id, empty means no head, anything else is not understood', () => {
  const options = employeeOptions(people);
  assert.equal(headIdFromInput('Dante B. Suarez Jr. (dante.suarez)', options), 2);
  assert.equal(headIdFromInput('  dante b. suarez jr. (DANTE.suarez) ', options), 2, 'case and spaces do not matter');
  assert.equal(headIdFromInput('', options), null);
  assert.equal(headIdFromInput('   ', options), null);
  assert.equal(headIdFromInput('Dante', options), undefined, 'half a name is not a choice');
  assert.equal(headIdFromInput('Nobody Here', options), undefined);
});

test('a head that was typed but not recognised is reported and not saved', () => {
  const result = departmentChanges(current, [{ id: 1, name: 'MIS', headId: undefined }, { id: 3, name: 'HR', headId: 8 }]);
  assert.deepEqual(result.invalid, [1]);
  assert.deepEqual(result.changes.map((c) => c.id), [3]);
});
