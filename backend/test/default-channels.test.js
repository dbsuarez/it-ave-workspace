const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch;
let db;

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  db = await scratch.open();
  await scratch.applyInit(db);
  await scratch.applyMigrations(db);
});

test.after(async () => {
  if (db) await db.end();
  if (scratch) await scratch.drop();
});

test('restore repairs built-in channels and their active member access', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const owner = (await db.query(
    `INSERT INTO users (username, email, password_hash, account_type)
     VALUES ('default-owner', 'default-owner@test.invalid', 'x', 'member') RETURNING id`
  )).rows[0];
  await db.query("DELETE FROM channels WHERE name IN ('general', 'welcome')");
  await db.query("UPDATE channels SET created_by = $1 WHERE name = 'announcements'", [owner.id]);
  const existing = (await db.query("SELECT id FROM channels WHERE name = 'random'")).rows[0];
  await db.query(
    'UPDATE moderation_settings SET workspace_sidebar_layout = $1 WHERE id = 1',
    [JSON.stringify({ sections: [{ id: 'existing-official', name: 'OFFICIAL', channelIds: [existing.id] }, { id: 'other', name: 'Other', channelIds: [] }] })]
  );

  const { DEFAULT_CHANNELS, ensureDefaultChannels } = require('../src/defaultChannels');
  await ensureDefaultChannels(db);
  await ensureDefaultChannels(db);

  const channels = (await db.query(
    'SELECT id, name, created_by FROM channels WHERE name = ANY($1::text[]) ORDER BY name',
    [DEFAULT_CHANNELS.map(([name]) => name)]
  )).rows;
  assert.equal(channels.length, DEFAULT_CHANNELS.length);
  assert.ok(channels.every((channel) => channel.created_by === null));
  assert.equal((await db.query(
    'SELECT COUNT(*)::int AS count FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE cm.user_id = $1 AND c.name = ANY($2::text[])',
    [owner.id, DEFAULT_CHANNELS.map(([name]) => name)]
  )).rows[0].count, DEFAULT_CHANNELS.length);
  const layout = (await db.query('SELECT workspace_sidebar_layout FROM moderation_settings WHERE id = 1')).rows[0].workspace_sidebar_layout;
  assert.deepEqual(layout.sections[0], {
    id: 'builtin-official', name: 'OFFICIAL', builtIn: true,
    channelIds: [Number(existing.id), ...DEFAULT_CHANNELS.map(([name]) => Number(channels.find((channel) => channel.name === name).id))],
  });
  assert.equal(layout.sections.filter((section) => section.name === 'OFFICIAL').length, 1);
  assert.equal(layout.sections[1].name, 'Other');
});
