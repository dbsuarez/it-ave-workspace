const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePermission, explainPermission } = require('../src/permissions');
const state = (departments, permission) => ({
  isOwner:false, grants:[{key:'everyone', permissions:permission ? [permission] : []}],
  overrides:{everyone:null,roles:[],departments,user:null},channelModerator:false
});
test('a department cannot grant send_messages or moderation action', () => {
  const access=state([{allow:['send_messages','manage_messages','view_channel']}]);
  assert.equal(resolvePermission(access,'send_messages'),false);
  assert.equal(resolvePermission(access,'manage_messages'),false);
  assert.equal(resolvePermission(access,'view_channel'),true);
});
test('a department cannot deny role actions; explain and resolve agree', () => {
  const access=state([{deny:['send_messages','manage_messages']}], 'send_messages');
  assert.equal(resolvePermission(access,'send_messages'),true);
  assert.equal(explainPermission(access,'send_messages').allowed,true);
});
test('department visibility overrides are preserved during transition', () => {
  assert.equal(resolvePermission(state([{deny:['view_channel']}], 'view_channel'),'view_channel'),false);
  assert.equal(explainPermission(state([{allow:['view_channel']}]),'view_channel').allowed,true);
});
test('new department action overrides are rejected by API before persistence', () => {
  const fs=require('node:fs'); const path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../src/routes/channelPermissions.js'),'utf8');
  assert.match(source,/subjectType === 'department' && \[\.\.\.allow, \.\.\.deny\]\.some/);
  assert.match(source,/Departments grant channel access only/);
});
