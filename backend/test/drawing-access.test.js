// Drawings: who may open and edit which drawing. Channel and forum drawings follow channel access exactly (bans, department
// membership, the Owner private-channel switch); standalone drawings follow the owner and the people they invite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let db; let access; let pool;
const ids = {};
const q = (...args) => db.query(...args);

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  db = await scratch.open();
  await scratch.applyInit(db);
  await scratch.applyMigrations(db);
  process.env.DATABASE_URL = scratch.url;
  pool = require('../src/db').pool;
  access = require('../src/drawingAccess');
  const forums = require('../src/forums');
  const add = async (name, extra = {}) => (await q(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, `${name}@x.test`, 'x', extra.type || 'member', Boolean(extra.superadmin)])).rows[0].id;
  for (const name of ['owner', 'ann', 'bob', 'cara', 'banned', 'ed', 'vi', 'gone']) ids[name] = await add(`da-${name}`);
  ids.guest = await add('da-guest', { type: 'guest' });
  ids.guestEd = await add('da-guest-ed', { type: 'guest' });
  ids.boss = await add('da-boss', { superadmin: true });
  ids.mis = (await q("INSERT INTO departments (name) VALUES ('MIS') RETURNING id")).rows[0].id;
  ids.legal = (await q("INSERT INTO departments (name) VALUES ('Legal') RETURNING id")).rows[0].id;
  for (const [user, dept] of [['ann', 'mis'], ['bob', 'mis'], ['cara', 'legal']]) await q('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids[user], ids[dept]]);
  ids.forum = await forums.ensureDepartmentForum(q, ids.mis);
  ids.chan = (await q("INSERT INTO channels (name) VALUES ('da-chan') RETURNING id")).rows[0].id;
  ids.archivedChan = (await q("INSERT INTO channels (name, archived_at) VALUES ('da-archived', NOW()) RETURNING id")).rows[0].id;
  for (const user of ['ann', 'banned', 'guest']) for (const chan of [ids.chan, ids.archivedChan]) await q('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [chan, ids[user]]);
  await q("INSERT INTO channel_bans (channel_id, user_id, reason) VALUES ($1, $2, 'test')", [ids.chan, ids.banned]);
  const topic = async (extra) => (await q(`INSERT INTO forum_topics (channel_id, title, created_by ${extra ? ', ' + extra : ''}) VALUES ($1, 'T', $2 ${extra ? ', NOW()' : ''}) RETURNING id`, [ids.forum, ids.ann])).rows[0].id;
  ids.topicOpen = await topic(); ids.topicLocked = await topic('locked_at'); ids.topicArchived = await topic('archived_at');
  const draw = async (title, channel, topicId) => (await q('INSERT INTO drawings (title, owner_id, channel_id, topic_id) VALUES ($1, $2, $3, $4) RETURNING id', [title, ids.owner, channel || null, topicId || null])).rows[0].id;
  ids.standalone = await draw('standalone');
  await q("INSERT INTO drawing_members (drawing_id, user_id, role) VALUES ($1, $2, 'editor'), ($1, $3, 'viewer'), ($1, $4, 'editor')", [ids.standalone, ids.ed, ids.vi, ids.guestEd]);
  ids.channelDrawing = await draw('channel', ids.chan);
  ids.archivedChannelDrawing = await draw('archived channel', ids.archivedChan);
  ids.topicDrawing = await draw('topic', ids.forum, ids.topicOpen);
  ids.lockedDrawing = await draw('locked', ids.forum, ids.topicLocked);
  ids.archivedTopicDrawing = await draw('archived topic', ids.forum, ids.topicArchived);
});

test.after(async () => {
  if (pool) await pool.end();
  if (db) await db.end();
  if (scratch) await scratch.drop();
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const role = async (user, drawingId) => access.drawingRole(q, ids[user], await access.loadDrawing(q, ids[drawingId]));

test('a standalone drawing: the owner and invited editors edit, invited viewers view, everyone else is out; a guest never edits', async (t) => {
  if (skip(t)) return;
  assert.equal(await role('owner', 'standalone'), 'editor');
  assert.equal(await role('ed', 'standalone'), 'editor');
  assert.equal(await role('vi', 'standalone'), 'viewer');
  assert.equal(await role('ann', 'standalone'), null);
  assert.equal(await role('boss', 'standalone'), null, 'not even an Owner, unless invited');
  assert.equal(await role('guestEd', 'standalone'), 'viewer', 'invited as editor, but a guest account only views');
});

test('a deactivated person has no access to anything', async (t) => {
  if (skip(t)) return;
  await q("INSERT INTO drawing_members (drawing_id, user_id, role) VALUES ($1, $2, 'editor')", [ids.standalone, ids.gone]);
  assert.equal(await role('gone', 'standalone'), 'editor');
  await q('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [ids.gone]);
  assert.equal(await role('gone', 'standalone'), null);
});

test('a channel drawing follows channel access: members edit, a guest member views, outsiders and the banned are out', async (t) => {
  if (skip(t)) return;
  assert.equal(await role('ann', 'channelDrawing'), 'editor');
  assert.equal(await role('guest', 'channelDrawing'), 'viewer');
  assert.equal(await role('cara', 'channelDrawing'), null);
  assert.equal(await role('banned', 'channelDrawing'), null, 'a ban removes access at once');
  assert.equal(await role('boss', 'channelDrawing'), 'editor', 'an Owner may open any public channel, as with messages (private ones are covered below)');
  assert.equal(await role('ed', 'channelDrawing'), null, 'being invited to some other drawing grants nothing here');
});

test('the Owner private-channel switch opens a channel drawing for an Owner, as it opens the channel', async (t) => {
  if (skip(t)) return;
  const priv = (await q("INSERT INTO channels (name, is_private) VALUES ('da-private', TRUE) RETURNING id")).rows[0].id;
  const id = (await q('INSERT INTO drawings (title, owner_id, channel_id) VALUES ($1, $2, $3) RETURNING id', ['private', ids.owner, priv])).rows[0].id;
  const drawing = await access.loadDrawing(q, id);
  assert.equal(await access.drawingRole(q, ids.boss, drawing), null);
  await q('UPDATE moderation_settings SET owner_private_channel_access = TRUE WHERE id = 1');
  assert.equal(await access.drawingRole(q, ids.boss, drawing), 'editor');
  await q('UPDATE moderation_settings SET owner_private_channel_access = FALSE WHERE id = 1');
  assert.equal(await access.drawingRole(q, ids.boss, drawing), null);
});

test('a forum topic drawing follows department membership live: moving someone out closes it at once', async (t) => {
  if (skip(t)) return;
  assert.equal(await role('bob', 'topicDrawing'), 'editor');
  assert.equal(await role('cara', 'topicDrawing'), null);
  await q('DELETE FROM user_departments WHERE user_id = $1 AND department_id = $2', [ids.bob, ids.mis]);
  assert.equal(await role('bob', 'topicDrawing'), null);
  await q('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids.bob, ids.mis]);
  assert.equal(await role('bob', 'topicDrawing'), 'editor');
});

test('where a drawing lives being archived or locked makes it view-only for everyone, and says why', async (t) => {
  if (skip(t)) return;
  const reason = async (user, drawingId) => (await access.drawingAccess(q, ids[user], await access.loadDrawing(q, ids[drawingId])));
  assert.deepEqual(await reason('ann', 'lockedDrawing'), { role: 'viewer', readOnlyReason: 'locked' });
  assert.deepEqual(await reason('ann', 'archivedTopicDrawing'), { role: 'viewer', readOnlyReason: 'archived' });
  assert.deepEqual(await reason('ann', 'archivedChannelDrawing'), { role: 'viewer', readOnlyReason: 'archived' });
  assert.deepEqual(await reason('ann', 'channelDrawing'), { role: 'editor', readOnlyReason: null });
  assert.deepEqual(await reason('cara', 'lockedDrawing'), { role: null, readOnlyReason: null }, 'an outsider learns nothing about its state');
  const archivedForum = (await q("INSERT INTO channels (name, kind, is_private, archived_at) VALUES ('dept-old', 'forum', TRUE, NOW()) RETURNING id")).rows[0].id;
  await q('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [archivedForum, ids.ann]);
  const topic = (await q("INSERT INTO forum_topics (channel_id, title, created_by) VALUES ($1, 'old', $2) RETURNING id", [archivedForum, ids.ann])).rows[0].id;
  const id = (await q('INSERT INTO drawings (title, owner_id, channel_id, topic_id) VALUES ($1, $2, $3, $4) RETURNING id', ['old', ids.owner, archivedForum, topic])).rows[0].id;
  assert.equal((await access.drawingAccess(q, ids.ann, await access.loadDrawing(q, id))).role, 'viewer', 'an archived forum');
});

test('requireDrawingRole: 404 for a missing drawing, 403 for no access or too little, and the drawing comes back with the role', async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => access.requireDrawingRole(q, ids.ann, 999999, 'viewer'), (e) => e.status === 404);
  await assert.rejects(() => access.requireDrawingRole(q, ids.cara, ids.channelDrawing, 'viewer'), (e) => e.status === 403);
  await assert.rejects(() => access.requireDrawingRole(q, ids.vi, ids.standalone, 'editor'), (e) => e.status === 403 && /view/i.test(e.message));
  await assert.rejects(() => access.requireDrawingRole(q, ids.ann, ids.lockedDrawing, 'editor'), (e) => e.status === 409 || e.status === 403);
  const ok = await access.requireDrawingRole(q, ids.ed, ids.standalone, 'editor');
  assert.equal(ok.role, 'editor');
  assert.equal(ok.drawing.id, ids.standalone);
  assert.equal((await access.requireDrawingRole(q, ids.vi, ids.standalone, 'viewer')).role, 'viewer');
  assert.equal((await access.requireDrawingRole(q, ids.ann, ids.lockedDrawing, 'viewer')).readOnlyReason, 'locked');
});
