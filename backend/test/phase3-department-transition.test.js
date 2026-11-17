const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planDepartmentOverrideMigration, readDepartmentOverrideMigrationPlan } = require('../src/departmentOverrideMigration');

test('access-only department allow can be planned without changing any rows', () => {
  const [plan] = planDepartmentOverrideMigration([{ channel_id: 7, subject_id: 4, allow: ['view_channel'], deny: [] }]);
  assert.equal(plan.safeToConvertAccessAllow, true);
  assert.deepEqual(plan.blockers, []);
});

test('historical department action allow and deny block automatic conversion', () => {
  const [plan] = planDepartmentOverrideMigration([{ channel_id: 7, subject_id: 4,
    allow: ['view_channel','send_messages'], deny: ['manage_messages'] }]);
  assert.equal(plan.safeToConvertAccessAllow, false);
  assert.deepEqual(plan.actionAllows, ['send_messages']);
  assert.deepEqual(plan.actionDenies, ['manage_messages']);
  assert.ok(plan.blockers.includes('department_action_override_requires_explicit_role_or_user_mapping'));
});

test('department access deny requires separate ban or policy review', () => {
  const [plan] = planDepartmentOverrideMigration([{channel_id: 3, subject_id: 2,
    allow: [], deny: ['view_channel']}]);
  assert.equal(plan.safeToConvertAccessAllow, false);
  assert.ok(plan.blockers.includes('department_access_deny_requires_explicit_ban_or_access_policy_review'));
});

test('migration planning is strictly read only', async () => {
  let sql;
  const rows = await readDepartmentOverrideMigrationPlan(async (query) => {
    sql = query; return { rows: [{ channel_id: 2, subject_id: 3, allow: [], deny: [] }] };
  });
  assert.equal(rows.length, 1);
  assert.match(sql, /WHERE subject_type = 'department'/);
  assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/i);
});

test('new department channels only grant entry; never write department action overrides', () => {
  const text = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
  const create = text.slice(text.indexOf('// Add creator as moderator'), text.indexOf('    if (teamSection) {', text.indexOf('// Add creator as moderator')));
  assert.match(create, /INSERT INTO channel_department_grants/);
  assert.doesNotMatch(create, /INSERT INTO channel_overrides/);
});
