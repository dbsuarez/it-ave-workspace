const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = fs.readFileSync(path.join(__dirname, '../../frontend/src/features/admin.js'), 'utf8');

test('employee role reset appears within Superadmin workspace administration', () => {
  assert.match(ui, /if \(!host \|\| !state\.moderation\.isSuperadmin\) return/);
  assert.match(ui, /id="admin-employee-role-reset" data-mod-tab="people"/);
  assert.match(ui, /'admin-employee-role-reset': 'members'/);
  assert.match(ui, /data-admin-action="employee-role-reset-open"/);
});
test('employee role reset requires an exact phrase and second confirmation', () => {
  assert.match(ui, /input\.value !== 'RESET EMPLOYEE ROLES'/);
  assert.match(ui, /await confirmAction\(\{ title: 'Reset roles', message: 'Reset roles for ALL non-Owner employees/);
  assert.match(ui, /confirmButton\.disabled = event\.target\.value !== 'RESET EMPLOYEE ROLES'/);
  assert.match(ui, /data-admin-action="employee-role-reset-cancel"/);
});
test('employee reset uses protected backend endpoint and reports counts', () => {
  assert.match(ui, /adminApi\('\/api\/admin\/employee-role-reset', 'POST', \{ confirmation: input\.value \}\)/);
  for (const field of ['employeeCount', 'rolesRemoved', 'overridesChanged']) assert.ok(ui.includes(`result.${field}`));
  assert.match(ui, /await Promise\.all\(\[loadUsers\(\), loadModerationAccess\(\)\]\)/);
});
