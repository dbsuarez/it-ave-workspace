const test = require('node:test');
const assert = require('node:assert/strict');
const { effectiveAccess, normalizeExpiration, inspectAccess } = require('../src/channelAccessPhase2');

test('department grants are unioned across primary and secondary departments', () => {
  assert.deepEqual(effectiveAccess({ active: true, banned: false, departmentIds: [1,2], allowedDepartmentIds: [2,3] }),
    { allowed: true, sources: ['department:2'] });
});
test('ban overrides department and direct membership', () => {
  assert.equal(effectiveAccess({ active: true, banned: true, departmentIds: [1], allowedDepartmentIds: [1], directGrant: {} }).allowed, false);
});
test('inactive accounts cannot access even through invitations', () => {
  assert.equal(effectiveAccess({ active: false, banned: false, directGrant: {} }).allowed, false);
});
test('expired direct grant does not override another department grant', () => {
  const policy = { active: true, banned: false, departmentIds: [3], allowedDepartmentIds: [3], directGrant: { expiresAt: '2020-01-01T00:00:00Z' } };
  assert.deepEqual(effectiveAccess(policy).sources, ['department:3']);
});
test('direct grant is independent of department membership', () => {
  assert.deepEqual(effectiveAccess({ active: true, banned: false, directGrant: {} }).sources, ['direct']);
});
test('expired direct grant alone denies access', () => {
  assert.equal(effectiveAccess({ active: true, banned: false, directGrant: { expiresAt: '2020-01-01T00:00:00Z' } }).allowed, false);
});
test('invalid expiration is rejected', () => {
  assert.throws(() => normalizeExpiration('bad-date'), RangeError);
  assert.throws(() => normalizeExpiration('2020-01-01T00:00:00Z'), RangeError);
  assert.equal(normalizeExpiration(null), null);
});
test('database inspection uses authoritative grants and bans', async () => {
  const mock = async (sql, args) => {
    assert.match(sql, /channel_bans/);
    assert.deepEqual(args, [8, 12]);
    return { rows: [{ active: true, banned: false, department_ids: [2], allowed_department_ids: [2], direct_exists: false }] };
  };
  assert.deepEqual(await inspectAccess(mock, 8, 12), { allowed: true, sources: ['department:2'] });
});
