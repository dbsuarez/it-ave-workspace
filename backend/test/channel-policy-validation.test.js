const test = require('node:test');
const assert = require('node:assert/strict');
const { idList, membershipInput, inviteInput, banInput } = require('../src/channelPolicyValidation');
test('reject duplicate or invalid department ids', () => {
  assert.deepEqual(idList([1,2]),[1,2]);
  assert.throws(()=>idList([1,1]));
  assert.throws(()=>idList([0]));
  assert.throws(()=>idList('1'));
});
test('primary department must belong to assigned list', () => {
  assert.deepEqual(membershipInput({departmentIds:[2,3],primaryDepartmentId:2}),{departmentIds:[2,3],primary:2});
  assert.throws(()=>membershipInput({departmentIds:[2,3],primaryDepartmentId:1}));
  assert.throws(()=>membershipInput({departmentIds:[2]}));
  assert.deepEqual(membershipInput({departmentIds:[]}),{departmentIds:[],primary:null});
});
test('direct invites validate expiry and IDs', () => {
  assert.deepEqual(inviteInput({userId:4}),{userId:4,expiresAt:null});
  assert.throws(()=>inviteInput({userId:0}));
  assert.throws(()=>inviteInput({userId:3,expiresAt:'bad-date'}));
});
test('ban reason is mandatory and length bounded', () => {
  assert.deepEqual(banInput({userId:4,reason:' spam '}),{userId:4,reason:'spam'});
  assert.throws(()=>banInput({userId:4,reason:'  '}));
  assert.throws(()=>banInput({userId:4,reason:'a'.repeat(501)}));
});
