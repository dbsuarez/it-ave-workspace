const test = require('node:test');
const assert = require('node:assert/strict');
const { roleDepartmentsText, roleDepartmentChecklistHtml, sameDepartmentList, roleDepartmentConfirmText } = require('../src/features/role-departments');

const departments = [{ id: 1, name: 'MIS', memberCount: 4 }, { id: 2, name: 'Finance & Legal', memberCount: 2 }, { id: 3, name: 'HR', memberCount: 1 }];

test('a role row says which departments give it, or nothing when none do', () => {
  assert.equal(roleDepartmentsText({ departmentIds: [] }, departments), '');
  assert.equal(roleDepartmentsText({ departmentIds: [1] }, departments), 'given by MIS');
  assert.equal(roleDepartmentsText({ departmentIds: [2, 1] }, departments), 'given by Finance & Legal, MIS');
  assert.equal(roleDepartmentsText({ departmentIds: [9] }, departments), '', 'a department that is gone is not named');
});

test('the checklist has one escaped box per department, in name order, with the chosen ones ticked', () => {
  const html = roleDepartmentChecklistHtml(departments, [2], { disabled: false });
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
  assert.match(html, /value="2" checked/);
  assert.doesNotMatch(html, /value="1" checked/);
  assert.match(html, /Finance &amp; Legal/);
  assert.ok(html.indexOf('Finance') < html.indexOf('HR') && html.indexOf('HR') < html.indexOf('MIS'));
});

test('with no departments the checklist says so, and a disabled checklist cannot be changed', () => {
  assert.match(roleDepartmentChecklistHtml([], [], {}), /no departments/i);
  assert.match(roleDepartmentChecklistHtml(departments, [], { disabled: true }), /disabled/);
});

test('two lists of departments are the same whatever their order', () => {
  assert.equal(sameDepartmentList([1, 2], [2, 1]), true);
  assert.equal(sameDepartmentList([1], [1, 2]), false);
  assert.equal(sameDepartmentList([], []), true);
});

test('the confirmation says who gains the role and that a hand-given role is kept', () => {
  const text = roleDepartmentConfirmText('MIS tools', departments, [], [1, 3]);
  assert.match(text, /MIS tools/);
  assert.match(text, /5 people/);
  assert.match(text, /given by hand/i);
  const lose = roleDepartmentConfirmText('MIS tools', departments, [1, 3], []);
  assert.match(lose, /lose/i);
});
