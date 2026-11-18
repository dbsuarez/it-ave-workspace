// Drawings: the tables, and what deleting a channel, a forum topic or a person does to them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let db;
const ids = {};
const q = (...args) => db.query(...args);

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  db = await scratch.open();
  await scratch.applyInit(db);
  await scratch.applyMigrations(db);
  ids.owner = (await q("INSERT INTO users (username, email, password_hash) VALUES ('ds-owner', 'ds-owner@x.test', 'x') RETURNING id")).rows[0].id;
  ids.other = (await q("INSERT INTO users (username, email, password_hash) VALUES ('ds-other', 'ds-other@x.test', 'x') RETURNING id")).rows[0].id;
  ids.channel = (await q("INSERT INTO channels (name) VALUES ('ds-channel') RETURNING id")).rows[0].id;
  ids.forum = (await q("INSERT INTO channels (name, kind, is_private) VALUES ('dept-ds', 'forum', TRUE) RETURNING id")).rows[0].id;
  ids.topic = (await q("INSERT INTO forum_topics (channel_id, title, created_by) VALUES ($1, 'T', $2) RETURNING id", [ids.forum, ids.owner])).rows[0].id;
});

test.after(async () => {
  if (db) await db.end();
  if (scratch) await scratch.drop();
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const cols = async (table) => (await q('SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name', [table])).rows.map((r) => r.column_name);
const draw = async (title, extra = {}) => (await q(
  'INSERT INTO drawings (title, owner_id, channel_id, topic_id) VALUES ($1, $2, $3, $4) RETURNING id',
  [title, extra.owner || ids.owner, extra.channel || null, extra.topic || null])).rows[0].id;

test('the drawing tables have the agreed columns, and running the migrations again changes nothing', async (t) => {
  if (skip(t)) return;
  assert.deepEqual(await cols('drawings'), ['channel_id', 'created_at', 'id', 'message_id', 'owner_id', 'preview', 'preview_at', 'revision', 'scene', 'title', 'topic_id', 'updated_at', 'updated_by']);
  assert.deepEqual(await cols('drawing_members'), ['drawing_id', 'role', 'user_id']);
  assert.deepEqual(await cols('drawing_files'), ['bytes', 'drawing_id', 'file_key', 'mime']);
  await scratch.applyMigrations(db);
  await scratch.applyMigrations(db);
  const id = await draw('defaults');
  const row = (await q('SELECT revision, scene FROM drawings WHERE id = $1', [id])).rows[0];
  assert.equal(row.revision, 1);
  assert.deepEqual(row.scene, { elements: [], appState: {} });
});

test('deleting a channel deletes its drawings; deleting a forum topic deletes the drawings in it', async (t) => {
  if (skip(t)) return;
  const inChannel = await draw('in channel', { channel: ids.channel });
  const inTopic = await draw('in topic', { channel: ids.forum, topic: ids.topic });
  const standalone = await draw('standalone');
  await q('DELETE FROM forum_topics WHERE id = $1', [ids.topic]);
  assert.equal((await q('SELECT 1 FROM drawings WHERE id = $1', [inTopic])).rows.length, 0, 'topic drawing gone');
  assert.equal((await q('SELECT 1 FROM drawings WHERE id = $1', [inChannel])).rows.length, 1);
  await q('DELETE FROM channels WHERE id = $1', [ids.channel]);
  assert.equal((await q('SELECT 1 FROM drawings WHERE id = $1', [inChannel])).rows.length, 0, 'channel drawing gone');
  assert.equal((await q('SELECT 1 FROM drawings WHERE id = $1', [standalone])).rows.length, 1, 'standalone drawings are not tied to a channel');
});

test('members take only the roles editor and viewer, once per person; members and files go with the drawing and with the person', async (t) => {
  if (skip(t)) return;
  const id = await draw('shared');
  await q("INSERT INTO drawing_members (drawing_id, user_id, role) VALUES ($1, $2, 'viewer')", [id, ids.other]);
  await assert.rejects(() => q("INSERT INTO drawing_members (drawing_id, user_id, role) VALUES ($1, $2, 'owner')", [id, ids.owner]), /check|violates/i);
  await assert.rejects(() => q("INSERT INTO drawing_members (drawing_id, user_id, role) VALUES ($1, $2, 'editor')", [id, ids.other]), /duplicate|unique/i);
  await q("INSERT INTO drawing_files (drawing_id, file_key, mime, bytes) VALUES ($1, 'img1', 'image/png', $2)", [id, Buffer.from('png-bytes')]);
  assert.equal((await q('SELECT bytes FROM drawing_files WHERE drawing_id = $1', [id])).rows[0].bytes.toString(), 'png-bytes');
  await assert.rejects(() => q("INSERT INTO drawing_files (drawing_id, file_key, mime, bytes) VALUES ($1, 'img1', 'image/png', $2)", [id, Buffer.from('x')]), /duplicate|unique/i);
  await q('DELETE FROM drawings WHERE id = $1', [id]);
  assert.equal((await q('SELECT 1 FROM drawing_members WHERE drawing_id = $1', [id])).rows.length, 0);
  assert.equal((await q('SELECT 1 FROM drawing_files WHERE drawing_id = $1', [id])).rows.length, 0);
});

test('a drawing keeps existing when the person who last saved it is deleted, but goes with its owner', async (t) => {
  if (skip(t)) return;
  const spare = (await q("INSERT INTO users (username, email, password_hash) VALUES ('ds-spare', 'ds-spare@x.test', 'x') RETURNING id")).rows[0].id;
  const id = await draw('owned by owner');
  await q('UPDATE drawings SET updated_by = $1 WHERE id = $2', [spare, id]);
  await q('DELETE FROM users WHERE id = $1', [spare]);
  assert.equal((await q('SELECT updated_by FROM drawings WHERE id = $1', [id])).rows[0].updated_by, null);
  const mine = await draw('goes with owner', { owner: ids.other });
  await q('DELETE FROM users WHERE id = $1', [ids.other]);
  assert.equal((await q('SELECT 1 FROM drawings WHERE id = $1', [mine])).rows.length, 0);
});
