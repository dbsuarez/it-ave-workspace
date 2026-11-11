const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOrgTree, orgPathAbove, orgTeamSize, filterOrgTree } = require('../src/features/org-chart');

const person = (id, username, managerId = null, extra = {}) => ({ id, username, managerId, ...extra });
const names = (nodes) => nodes.map((n) => n.person.username);
const flat = (nodes) => nodes.flatMap((n) => [n.person.username, ...flat(n.children)]);

test('people are arranged under their managers, siblings sorted by name', () => {
  const tree = buildOrgTree([
    person(1, 'boss'), person(2, 'zed', 1), person(3, 'amy', 1), person(4, 'kim', 3), person(5, 'bob', 3),
  ]);
  assert.deepEqual(names(tree), ['boss']);
  assert.deepEqual(names(tree[0].children), ['amy', 'zed']);
  assert.deepEqual(names(tree[0].children[0].children), ['bob', 'kim']);
  assert.equal(orgTeamSize(tree[0]), 4);
  assert.equal(orgTeamSize(tree[0].children[1]), 0);
});

test('people without a manager are roots, with real hierarchies before loose individuals', () => {
  const tree = buildOrgTree([person(1, 'zoe'), person(2, 'boss'), person(3, 'amy', 2), person(4, 'abe')]);
  assert.deepEqual(names(tree), ['boss', 'abe', 'zoe']);
});

test('a missing manager, a self-manager or a loop never hides or repeats anyone', () => {
  const everyone = [
    person(1, 'a', 2), person(2, 'b', 3), person(3, 'c', 1), // a loop
    person(4, 'd', 99), // manager does not exist
    person(5, 'e', 5), // reports to themselves
    person(6, 'f', 4),
  ];
  const tree = buildOrgTree(everyone);
  const placed = flat(tree);
  assert.equal(placed.length, 6);
  assert.deepEqual([...placed].sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.ok(tree.some((n) => n.person.username === 'd' && n.children[0].person.username === 'f'), 'a person whose manager is missing leads their own team');
});

test('an empty directory is an empty chart', () => {
  assert.deepEqual(buildOrgTree([]), []);
});

test('the path above someone lists their managers, nearest first, and stops at a loop', () => {
  const people = [person(1, 'ceo'), person(2, 'vp', 1), person(3, 'lead', 2), person(4, 'dev', 3)];
  assert.deepEqual(orgPathAbove(people, 4).map((p) => p.username), ['lead', 'vp', 'ceo']);
  assert.deepEqual(orgPathAbove(people, 1), []);
  const loop = [person(1, 'a', 2), person(2, 'b', 1)];
  assert.deepEqual(orgPathAbove(loop, 1).map((p) => p.username), ['b']);
});

test('searching keeps the managers above a match', () => {
  const tree = buildOrgTree([
    person(1, 'boss', null, { department: 'Exec' }), person(2, 'amy', 1, { jobTitle: 'Network Engineer', department: 'MIS' }),
    person(3, 'bob', 1, { department: 'HR' }), person(4, 'cy', 2, { department: 'MIS' }),
  ]);
  const found = filterOrgTree(tree, 'engineer');
  assert.deepEqual(flat(found), ['boss', 'amy'], 'the match and the chain above it');
  assert.equal(found[0].children[0].matched, true);
  assert.deepEqual(flat(filterOrgTree(tree, 'mis')).sort(), ['amy', 'boss', 'cy']);
  assert.deepEqual(filterOrgTree(tree, 'nobody'), []);
  assert.equal(filterOrgTree(tree, '  '), tree, 'an empty search shows everything');
});
