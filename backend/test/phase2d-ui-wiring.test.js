const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../frontend/src');
const get = file => fs.readFileSync(path.join(root, file), 'utf8');
test('channel access tab is distinct from action permissions and wired to its API', () => {
 const app = get('renderer.js'), ui = get('features/channel-access.js');
 assert.match(app, /access: \['Access'/);
 assert.match(app, /moderation-channel-access/);
 assert.match(ui, /confirmHistoryExposure:true/);
 assert.match(ui, /access-policy\/ban/);
 assert.match(ui, /access-policy\/invitation/);
});
test('employee department membership UI uses separate API with confirmation', () => {
 const employee = get('features/employees.js'), ui = get('features/channel-access.js');
 assert.match(employee,/loadEmployeeDepartments\(id\)/);
 assert.match(ui,/confirmAccessChanges: true/);
 assert.match(ui,/emp-primary-department/);
});
