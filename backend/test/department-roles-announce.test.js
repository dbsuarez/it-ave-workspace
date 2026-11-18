const test = require('node:test');
const assert = require('node:assert/strict');
const { announceRoleChanges } = require('../src/departmentRoles');

test('each change is written to the audit log as coming from a department rule, and the person is told their permissions changed', async () => {
  const sql = []; const emitted = [];
  const query = async (text, params) => { sql.push({ text, params }); return { rows: [] }; };
  const io = { emit: (name, payload) => emitted.push([name, payload]) };
  await announceRoleChanges(query, [{ userId: 7, added: [3], removed: [] }, { userId: 8, added: [], removed: [3, 4] }], { actorId: 2, io, departmentId: 5 });
  assert.equal(sql.length, 2);
  assert.match(sql[0].text, /moderation_audit_log/);
  assert.equal(sql[0].params[0], 2);
  assert.equal(sql[0].params[1], 7);
  assert.deepEqual(JSON.parse(sql[0].params[2]), { added: [3], removed: [], source: 'department rule', departmentId: 5 });
  assert.deepEqual(emitted, [['permissions_updated', { userId: 7, byUserId: 2 }], ['permissions_updated', { userId: 8, byUserId: 2 }]]);
});

test('with nothing changed nothing is written or sent, and no socket server is needed', async () => {
  const sql = [];
  await announceRoleChanges(async (text) => { sql.push(text); return { rows: [] }; }, [], {});
  await announceRoleChanges(async (text) => { sql.push(text); return { rows: [] }; }, [{ userId: 1, added: [2], removed: [] }], {});
  assert.equal(sql.length, 1);
});
