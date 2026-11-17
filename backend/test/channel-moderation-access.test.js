const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureChannelModerator } = require('../src/security');

// Always exercise the actual public check, not a mocked membership function.
test('a banned Owner cannot use channel moderation as a content-access bypass', async () => {
  let moderatorLookup = false;
  const query = async (sql) => {
    if (sql.includes('AS needs_check FROM channels c')) return { rows: [] };
    if (sql.includes('FROM users u') && sql.includes('JOIN channels c')) moderatorLookup = true;
    return { rows: [] };
  };
  await assert.rejects(ensureChannelModerator(query, 3, 9), { status: 403 });
  assert.equal(moderatorLookup, false, 'moderator privilege must not be queried after access denial');
});

test('an authorized moderator continues to pass after channel access is confirmed', async () => {
  let checkedMembership = false;
  const query = async (sql) => {
    if (sql.includes('AS needs_check FROM channels c')) {
      checkedMembership = true;
      return { rows: [{ needs_check: false }] };
    }
    if (sql.includes('FROM users u') && sql.includes('JOIN channels c')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('SELECT is_personal FROM channels')) return { rows: [{ is_personal: false }] };
    return { rows: [] };
  };
  await ensureChannelModerator(query, 3, 9);
  assert.equal(checkedMembership, true);
});
