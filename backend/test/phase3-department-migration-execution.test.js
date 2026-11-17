const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateAccessOnlyDepartmentOverride } = require('../src/departmentOverrideMigration');

const fake = (overrides = { channel_id: 7, subject_id: 4, allow: ['view_channel'], deny: [] }) => {
  const calls = [];
  const client = { async query(sql, args) {
    calls.push(sql);
    if (sql.includes('FOR UPDATE')) return { rows: [overrides] };
    if (sql.startsWith('SELECT id FROM users')) return { rows: [] };
    if (sql.includes('DELETE FROM channel_overrides')) return { rows: [{ channel_id: 7 }] };
    return { rows: [] };
  }};
  return { client, calls };
};

test('explicit approval required before any SQL is executed', async () => {
  const { client, calls } = fake();
  await assert.rejects(migrateAccessOnlyDepartmentOverride(client, { channelId: 7, departmentId: 4, dryRun: false }), /approved/);
  assert.equal(calls.length, 0);
});
test('only an access-only allow can commit inside a transaction', async () => {
  const { client, calls } = fake();
  const result = await migrateAccessOnlyDepartmentOverride(client, { channelId: 7, departmentId: 4, approved: true, dryRun: false });
  assert.equal(result.converted, true);
  assert.equal(calls.at(0), 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.equal(calls.at(-1), 'COMMIT');
  assert.ok(calls.some(x => x.includes('INSERT INTO channel_department_grants')));
  assert.ok(calls.some(x => x.includes('DELETE FROM channel_overrides')));
});
test('action overrides are rejected and transaction rolled back', async () => {
  const { client, calls } = fake({channel_id: 7, subject_id: 4, allow: ['view_channel', 'send_messages'], deny: []});
  await assert.rejects(migrateAccessOnlyDepartmentOverride(client, {channelId:7,departmentId:4,approved:true,dryRun:false}), /Unsafe/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.some(x => x.includes('INSERT INTO channel_department_grants')));
});
test('access deny is rejected and transaction rolled back', async () => {
  const { client, calls } = fake({channel_id: 7, subject_id: 4, allow: ['view_channel'], deny: ['view_channel']});
  await assert.rejects(migrateAccessOnlyDepartmentOverride(client, {channelId:7,departmentId:4,approved:true,dryRun:false}), /Unsafe/);
  assert.equal(calls.at(-1), 'ROLLBACK');
});
test('invalid identifiers are rejected before database access', async () => {
  const { client, calls } = fake();
  await assert.rejects(migrateAccessOnlyDepartmentOverride(client, {channelId:'7',departmentId:4,approved:true}), /Valid/);
  assert.equal(calls.length, 0);
});

test('dry-run is default and rolls back even when safe', async () => {
  const { client, calls } = fake();
  const result = await migrateAccessOnlyDepartmentOverride(client, {channelId:7, departmentId:4});
  assert.deepEqual({ converted: result.converted, dryRun: result.dryRun, safeToCommit: result.safeToCommit },
    {converted:false, dryRun:true, safeToCommit:true});
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.includes('COMMIT'));
});
test('explicit approved=true alone cannot override dry-run default', async () => {
  const { client, calls } = fake();
  const result = await migrateAccessOnlyDepartmentOverride(client, {channelId:7,departmentId:4,approved:true});
  assert.equal(result.converted, false);
  assert.equal(calls.at(-1), 'ROLLBACK');
});
test('an unsafe override cannot be committed or previewed as safe', async () => {
  const {client,calls} = fake({channel_id:7,subject_id:4,allow:['send_messages'],deny:[]});
  await assert.rejects(migrateAccessOnlyDepartmentOverride(client,{channelId:7,departmentId:4}),/Unsafe/);
  assert.equal(calls.at(-1),'ROLLBACK');
});
test('invalid dry-run type is rejected before querying database', async () => {
  const {client,calls} = fake();
  await assert.rejects(migrateAccessOnlyDepartmentOverride(client,{channelId:7,departmentId:4,dryRun:'false'}),/dryRun/);
  assert.equal(calls.length,0);
});
