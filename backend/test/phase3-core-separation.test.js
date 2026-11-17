const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { summarizeDepartmentOverrides, auditDepartmentOverrides } = require('../src/departmentOverrideAudit');

test('department override audit splits entry from action permissions without changing rules', () => {
  const [row] = summarizeDepartmentOverrides([{channel_id: 3, subject_id: 7,
    allow: ['view_channel', 'send_messages', 'attach_files'], deny: ['manage_messages']}]);
  assert.deepEqual(row.access, {allow: true, deny: false});
  assert.deepEqual(row.actionAllows, ['send_messages', 'attach_files']);
  assert.deepEqual(row.actionDenies, ['manage_messages']);
  assert.equal(row.requiresManualMigration, true);
});

test('access-only department override requires no action migration', () => {
  const [row] = summarizeDepartmentOverrides([{channel_id: 2, subject_id: 4, allow: ['view_channel'], deny: []}]);
  assert.equal(row.requiresManualMigration, false);
});

test('department override audit is read-only and scoped to legacy department entries', async () => {
  let sql;
  const result = await auditDepartmentOverrides(async (statement) => {sql = statement; return {rows: []};});
  assert.deepEqual(result, []);
  assert.match(sql, /WHERE subject_type = 'department'/);
  assert.doesNotMatch(sql, /DELETE|UPDATE|INSERT/i);
});

test('every channel action check is preceded by current membership verification', () => {
  const text = fs.readFileSync(path.join(__dirname,'../src/security.js'),'utf8');
  const body = text.split('async function ensureChannelPermission(')[1].split('async function ensureChannelModerator(')[0];
  assert.match(body, /await ensureChannelMembership\(query, userId, channelId\)/);
  assert.ok(body.indexOf('await ensureChannelMembership(') < body.indexOf('needsCheckSql('));
});
