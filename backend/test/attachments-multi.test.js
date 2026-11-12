// Several uploaded files on one message, claimed all together or not at all, against a real PostgreSQL (scratch database).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');
const { insertChannelMessage, insertDirectMessage, parseAttachmentIds, MAX_ATTACHMENTS } = require('../src/attachments');

let scratch;
let admin;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  const user = async (name) => (await admin.query('INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [name, `${name}@x.test`, 'x'])).rows[0].id;
  ids.ann = await user('ann');
  ids.bob = await user('bob');
  ids.channel = (await admin.query("INSERT INTO channels (name, created_by) VALUES ('pics', $1) RETURNING id", [ids.ann])).rows[0].id;
});

test.after(async () => {
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

const query = (sql, params) => admin.query(sql, params);
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const upload = async (owner, name) => (await admin.query(
  "INSERT INTO files (filename, original_name, size, mime_type, uploaded_by) VALUES ($1, $1, 10, 'image/png', $2) RETURNING id", [name, owner]
)).rows[0].id;

test('parsing: a list of up to 10 real ids, plus the older single id', () => {
  assert.deepEqual(parseAttachmentIds({ attachmentIds: [1, 2, 3] }), { ok: true, ids: [1, 2, 3] });
  assert.deepEqual(parseAttachmentIds({ attachmentId: 5 }), { ok: true, ids: [5] });
  assert.deepEqual(parseAttachmentIds({ attachmentIds: [1, 1, 2], attachmentId: 2 }), { ok: true, ids: [1, 2] }, 'no duplicates');
  assert.deepEqual(parseAttachmentIds({}), { ok: true, ids: [] });
  assert.equal(parseAttachmentIds({ attachmentIds: [1, 'x'] }).ok, false);
  assert.equal(parseAttachmentIds({ attachmentIds: [0] }).ok, false);
  assert.equal(parseAttachmentIds({ attachmentIds: Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => i + 1) }).ok, false, 'at most 10');
  assert.equal(parseAttachmentIds({ attachmentIds: Array.from({ length: MAX_ATTACHMENTS }, (_, i) => i + 1) }).ok, true);
});

test('a channel message carries several files, and only the sender\'s unattached ones', async (t) => {
  if (skip(t)) return;
  const [a, b, c] = [await upload(ids.ann, 'a.png'), await upload(ids.ann, 'b.png'), await upload(ids.ann, 'c.png')];
  const msg = await insertChannelMessage(query, { channelId: ids.channel, userId: ids.ann, content: 'three pictures', attachmentIds: [a, b, c] });
  assert.ok(msg);
  const linked = (await admin.query('SELECT id FROM files WHERE message_id = $1 ORDER BY id', [msg.id])).rows.map((r) => r.id);
  assert.deepEqual(linked, [a, b, c], 'all three are on the message');

  // one of the files is someone else's: nothing is created, nothing is attached
  const mine = await upload(ids.ann, 'mine.png');
  const theirs = await upload(ids.bob, 'theirs.png');
  const before = (await admin.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n;
  assert.equal(await insertChannelMessage(query, { channelId: ids.channel, userId: ids.ann, content: 'x', attachmentIds: [mine, theirs] }), null);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n, before, 'no message was left behind');
  assert.equal((await admin.query('SELECT message_id FROM files WHERE id = $1', [mine])).rows[0].message_id, null, 'my file stayed free');

  // a file already on a message cannot be used again
  assert.equal(await insertChannelMessage(query, { channelId: ids.channel, userId: ids.ann, content: 'again', attachmentIds: [a] }), null);
  // a file that does not exist
  assert.equal(await insertChannelMessage(query, { channelId: ids.channel, userId: ids.ann, content: 'ghost', attachmentIds: [999999] }), null);
});

test('the older single attachment id still works, and so do plain messages', async (t) => {
  if (skip(t)) return;
  const one = await upload(ids.ann, 'one.png');
  const msg = await insertChannelMessage(query, { channelId: ids.channel, userId: ids.ann, content: '', attachmentId: one });
  assert.ok(msg);
  assert.equal((await admin.query('SELECT message_id FROM files WHERE id = $1', [one])).rows[0].message_id, msg.id);
  const plain = await insertChannelMessage(query, { channelId: ids.channel, userId: ids.ann, content: 'just text' });
  assert.equal(plain.content, 'just text');
});

test('direct messages carry several files the same way', async (t) => {
  if (skip(t)) return;
  const [a, b] = [await upload(ids.ann, 'd1.png'), await upload(ids.ann, 'd2.png')];
  const dm = await insertDirectMessage(query, { senderId: ids.ann, receiverId: ids.bob, content: 'two', attachmentIds: [a, b] });
  assert.ok(dm);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM files WHERE dm_message_id = $1', [dm.id])).rows[0].n, 2);
  const theirs = await upload(ids.bob, 'd3.png');
  assert.equal(await insertDirectMessage(query, { senderId: ids.ann, receiverId: ids.bob, content: 'no', attachmentIds: [theirs] }), null, 'not yours');
});
