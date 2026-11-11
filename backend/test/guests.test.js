const test = require('node:test');
const assert = require('node:assert/strict');

const {
  newInviteCode, normalizeInviteCode, hashInviteCode, invitationProblem,
  ensureGuestCanReach, ensureNotGuest,
} = require('../src/guests');

const NOW = new Date('2026-11-11T08:00:00Z');

test('invitation codes are readable, unique, and hash case-insensitively', () => {
  const first = newInviteCode();
  const second = newInviteCode();
  assert.match(first, /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
  assert.notEqual(first, second);
  assert.equal(hashInviteCode(`  ${first.toUpperCase()} `), hashInviteCode(first));
  assert.equal(normalizeInviteCode(undefined), '');
});

test('an invitation is usable only while pending and unexpired', () => {
  const future = new Date('2026-11-12T08:00:00Z');
  assert.equal(invitationProblem({ expires_at: future }, NOW), null);
  assert.match(invitationProblem(undefined, NOW), /not valid/);
  assert.match(invitationProblem({ expires_at: future, revoked_at: NOW }, NOW), /revoked/);
  assert.match(invitationProblem({ expires_at: future, used_at: NOW }, NOW), /already been used/);
  assert.match(invitationProblem({ expires_at: new Date('2026-11-10T08:00:00Z') }, NOW), /expired/);
});

function fakeQuery({ types, shared }) {
  return async (sql, params) => {
    if (sql.includes('SELECT id, account_type FROM users')) {
      return { rows: params[0].map((id) => ({ id, account_type: types[id] })) };
    }
    if (sql.includes('SELECT account_type FROM users')) {
      return { rows: [{ account_type: types[params[0]] }] };
    }
    if (sql.includes('FROM channel_members mine')) return { rows: shared ? [{}] : [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
}

test('two members can always message each other', async () => {
  await ensureGuestCanReach(fakeQuery({ types: { 1: 'member', 2: 'member' }, shared: false }), 1, 2);
});

test('a guest can only be reached through a shared channel, in either direction', async () => {
  const types = { 1: 'guest', 2: 'member' };
  await ensureGuestCanReach(fakeQuery({ types, shared: true }), 1, 2);
  await assert.rejects(ensureGuestCanReach(fakeQuery({ types, shared: false }), 1, 2), { status: 403 });
  await assert.rejects(ensureGuestCanReach(fakeQuery({ types, shared: false }), 2, 1), { status: 403 });
});

test('ensureNotGuest blocks guests and lets members through', async () => {
  await ensureNotGuest(fakeQuery({ types: { 1: 'member' } }), 1);
  await assert.rejects(ensureNotGuest(fakeQuery({ types: { 1: 'guest' } }), 1, 'nope'), { status: 403, message: 'nope' });
});
