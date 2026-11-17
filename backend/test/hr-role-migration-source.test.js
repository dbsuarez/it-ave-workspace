const test = require('node:test');
const assert = require('node:assert/strict');
const migrations = require('../src/migrations');

test('legacy HR migration backfills assignments before removing builtin identity', () => {
  const find = (needle) => migrations.findIndex((sql) => sql.includes(needle));
  const seed = find("SELECT 'HR'");
  const backfill = find('SELECT u.id, r.id FROM users u CROSS JOIN roles r');
  const convert = find('UPDATE roles SET builtin_key = NULL');
  assert.ok(seed >= 0 && backfill > seed && convert > backfill);
  assert.match(migrations[seed], /NOT EXISTS/);
  assert.match(migrations[backfill], /ON CONFLICT DO NOTHING/);
  assert.match(migrations[convert], /legacy_hr = true/);
});
