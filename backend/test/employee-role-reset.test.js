const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modText = fs.readFileSync(path.join(__dirname, '../src/employeeRoleReset.js'), 'utf8');
const adminText = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
test('Employee reset is explicitly invoked by the authenticated admin route', () => {
  assert.match(adminText, /router\.post\('\/employee-role-reset'/);
  assert.match(adminText, /await requireSuperadmin\(req\)/);
  assert.match(adminText, /resetEmployeeRoles\(req\.user\.userId, req\.body\?\.confirmation\)/);
});
test('Employee reset protects Owner and guests and preserves channel access', () => {
  assert.match(modText, /account_type = 'member' AND is_superadmin = FALSE/);
  assert.match(modText, /subject_type = 'user'/);
  assert.match(modText, /EXCEPT SELECT unnest\(\$2::text\[\]\)/);
  assert.doesNotMatch(modText, /'view_channel',/);
  assert.match(modText, /DELETE FROM user_roles/);
});
test('Employee reset requires confirmation and uses rollback on errors', () => {
  assert.match(modText, /RESET EMPLOYEE ROLES/);
  assert.match(modText, /await client\.query\('BEGIN'\)/);
  assert.match(modText, /await client\.query\('ROLLBACK'\)/);
  assert.match(modText, /await client\.query\('COMMIT'\)/);
});
