const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch;
let admin;
let resetPool;

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
});

test.after(async () => {
  if (admin) await admin.end();
  if (resetPool) await resetPool.end();
  if (scratch) await scratch.drop();
});

test('workspace reset clears content but preserves organization and channel configuration', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  process.env.DATABASE_URL = scratch.url;
  const user = (await admin.query("INSERT INTO users (username, email, password_hash, token_version, profile_visit_count) VALUES ('reset-user', 'reset@x.test', 'x', 4, 12) RETURNING id")).rows[0];
  const channel = (await admin.query("INSERT INTO channels (name, topic, created_by) VALUES ('reset-channel', 'Keep me', $1) RETURNING id", [user.id])).rows[0];
  await admin.query("INSERT INTO channel_members (channel_id, user_id, role, last_message_at) VALUES ($1, $2, 'moderator', NOW())", [channel.id, user.id]);
  await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'Delete me')", [channel.id, user.id]);
  await admin.query("INSERT INTO moderation_audit_log (channel_id, actor_id, action, details) VALUES ($1, $2, 'test', '{}')", [channel.id, user.id]);

  const { clearDatabase } = require('../src/workspaceReset');
  resetPool = require('../src/db').pool;
  await admin.query('BEGIN');
  await clearDatabase(admin);
  await admin.query('COMMIT');

  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n, 0);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM moderation_audit_log')).rows[0].n, 0);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [user.id])).rows[0].n, 1);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM channels WHERE id = $1', [channel.id])).rows[0].n, 1);
  const account = (await admin.query('SELECT token_version, profile_visit_count, status FROM users WHERE id = $1', [user.id])).rows[0];
  assert.deepEqual(account, { token_version: 5, profile_visit_count: 0, status: 'offline' });
  assert.equal((await admin.query('SELECT last_message_at FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channel.id, user.id])).rows[0].last_message_at, null);
});
