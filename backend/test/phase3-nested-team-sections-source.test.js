const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const settings = fs.readFileSync(path.join(__dirname, '../src/routes/settings.js'), 'utf8');
test('team sections are inherited through the full reporting line', () => {
  assert.match(settings, /WITH RECURSIVE reporting_line AS/);
  assert.match(settings, /JOIN reporting_line r ON manager\.id = r\.manager_id/);
  assert.match(settings, /ts\.owner_id IN \(SELECT id FROM reporting_line\)/);
  assert.doesNotMatch(settings, /me\.manager_id = ts\.owner_id/);
});
