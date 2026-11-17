const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/employeeRoleReset.js'), 'utf8');
function loadReset(pool) {
  const module = { exports: {} };
  vm.runInNewContext(`(function(require, module, exports) { ${source}\n})`, { }, { filename: 'employeeRoleReset.js' })(
    (name) => { if (name === './db') return { pool }; throw Error(`Unexpected dependency: ${name}`); },
    module,
    module.exports
  );
  return module.exports.resetEmployeeRoles;
}
function fakePool({ failAt = null, actorIsOwner = true, employeeIds = [2, 3] } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (failAt && sql.includes(failAt)) throw Error('forced database failure');
      if (sql.includes('SELECT id FROM users WHERE id = $1 AND is_superadmin')) return { rows: actorIsOwner ? [{ id: 1 }] : [] };
      if (sql.includes("account_type = 'member' AND is_superadmin = FALSE")) return { rows: employeeIds.map(id => ({ id })) };
      if (sql.includes('DELETE FROM user_roles')) return { rows: [{ user_id: 2 }], rowCount: 1 };
      if (sql.includes('UPDATE channel_overrides')) return { rows: [{ channel_id: 10 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { released = true; },
  };
  return { pool: { async connect() { return client; } }, calls, get released() { return released; } };
}

test('reset requires confirmation without opening a database transaction', async () => {
  const db = fakePool();
  await assert.rejects(loadReset(db.pool)(1, 'WRONG'), /RESET EMPLOYEE ROLES/);
  assert.equal(db.calls.length, 0);
});
test('reset performs bounded transactional role/action cleanup and preserves channel visibility', async () => {
  const db = fakePool();
  const result = await loadReset(db.pool)(1, 'RESET EMPLOYEE ROLES');
  assert.equal(result.employeeCount, 2);
  assert.equal(result.rolesRemoved, 1);
  assert.equal(result.overridesChanged, 1);
  assert.equal(db.calls[0].sql, 'BEGIN');
  assert.equal(db.calls.at(-1).sql, 'COMMIT');
  const deletes = db.calls.filter(c => c.sql.startsWith('DELETE'));
  assert.equal(deletes.length, 1);
  assert.match(deletes[0].sql, /user_roles/);
  assert.deepEqual(Array.from(deletes[0].params[0]), [2,3]);
  const update = db.calls.find(c => c.sql.includes('UPDATE channel_overrides'));
  assert.ok(update);
  assert.ok(!update.params[1].includes('view_channel'));
  assert.ok(!db.calls.some(c => /DELETE FROM (users|channel_members|channels|messages)/.test(c.sql)));
  assert.equal(db.released, true);
});
test('reset refuses non-Owner actor and rolls back', async () => {
  const db = fakePool({ actorIsOwner: false });
  await assert.rejects(loadReset(db.pool)(1, 'RESET EMPLOYEE ROLES'), /Superadmin access required/);
  assert.deepEqual(db.calls.map(c => c.sql).filter(s => ['BEGIN','ROLLBACK','COMMIT'].includes(s)), ['BEGIN','ROLLBACK']);
  assert.equal(db.released, true);
});
test('reset rolls back when cleanup fails, without committing', async () => {
  const db = fakePool({ failAt: 'UPDATE channel_overrides' });
  await assert.rejects(loadReset(db.pool)(1, 'RESET EMPLOYEE ROLES'), /forced database failure/);
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(db.calls.some(c => c.sql === 'COMMIT'), false);
  assert.equal(db.released, true);
});
test('reset handles no non-Owner employees without deleting role or action data', async () => {
  const db = fakePool({ employeeIds: [] });
  const result = await loadReset(db.pool)(1, 'RESET EMPLOYEE ROLES');
  assert.equal(result.employeeCount, 0);
  assert.equal(db.calls.some(c => c.sql.includes('DELETE FROM user_roles')), false);
  assert.equal(db.calls.some(c => c.sql.includes('UPDATE channel_overrides')), false);
  assert.equal(db.calls.at(-1).sql, 'COMMIT');
});
