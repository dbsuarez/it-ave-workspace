// The department role re-check must run wherever department membership changes, and once at start-up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('editing a person, importing accounts, the multi-department editor and deleting a department all re-check the roles', () => {
  for (const file of [['src', 'routes', 'hr.js'], ['src', 'routes', 'admin.js'], ['src', 'routes', 'channelAccessPolicies.js']]) {
    assert.match(read(...file), /departmentRoles\.reconcile/, file.join('/'));
    assert.match(read(...file), /departmentRoles\.announceRoleChanges/, file.join('/'));
  }
  assert.match(read('src', 'routes', 'hr.js'), /departmentRoles\.reconcileEveryone/, 'deleting a department');
});

test('the server re-checks everyone when it starts, after the migrations', () => {
  const server = read('server.js');
  assert.match(server, /reconcileEveryone/);
  assert.ok(server.indexOf('reconcileEveryone') > server.indexOf('migrations.reduce'));
});
