const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('primary department changes preserve secondary membership and use a transaction', () => {
  const hr = src('routes/hr.js');
  assert.match(hr, /const client = departmentChanged \? await pool\.connect\(\) : null/);
  assert.match(hr, /if \(client\) await run\('BEGIN'\)/);
  assert.match(hr, /if \(client\) await run\('COMMIT'\)/);
  assert.match(hr, /if \(client\) await run\('ROLLBACK'\)/);
  assert.match(hr, /UPDATE user_departments SET is_primary = false WHERE user_id = \$1 AND is_primary = true/);
  assert.doesNotMatch(hr, /DELETE FROM user_departments WHERE user_id = \$1['`]/);
});

test('account creation and legacy backfill use membership records safely', () => {
  const admin = src('routes/admin.js');
  const migrations = src('migrations.js');
  assert.match(admin, /INSERT INTO user_departments\(user_id, department_id, is_primary\)/);
  assert.match(migrations, /NOT EXISTS \(SELECT 1 FROM user_departments ud WHERE ud\.user_id = u\.id AND ud\.is_primary\)/);
});
