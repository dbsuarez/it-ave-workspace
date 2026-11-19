// Search finds people by their name as well as their username, and says their full name (real PostgreSQL, scratch database).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let pool; let searchWorkspace; const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  pool = require('../src/db').pool;
  ({ searchWorkspace } = require('../src/searchService'));
  const add = async (username, first, middle, last) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, first_name, middle_name, last_name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [username, `${username}@x.test`, 'x', 'member', first, middle, last])).rows[0].id;
  ids.me = await add('sn-me', '', '', '');
  ids.jomar = await add('sn-jomar.deguzman', 'Jomar', 'R.', 'De Guzman');
  ids.nameless = await add('sn-nameless', '', '', '');
});

test.after(async () => {
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

test('a person is found by first or last name and comes back with their full name; someone with no name has none', async (t) => {
  if (!scratch) { t.skip('no PostgreSQL reachable'); return; }
  const { query } = require('../src/db');
  const byFirst = await searchWorkspace(query, ids.me, 'Jomar');
  assert.deepEqual(byFirst.people.map((p) => [p.username, p.fullName]), [['sn-jomar.deguzman', 'Jomar R. De Guzman']]);
  const byLast = await searchWorkspace(query, ids.me, 'guzman');
  assert.equal(byLast.people.length, 1);
  const byUsername = await searchWorkspace(query, ids.me, 'nameless');
  assert.deepEqual(byUsername.people.map((p) => [p.username, p.fullName]), [['sn-nameless', null]]);
});
