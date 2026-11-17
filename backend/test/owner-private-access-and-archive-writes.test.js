// Two Phase 5 follow-ups, against a real scratch PostgreSQL:
//  1. An Owner (Superadmin) cannot read or post in private channels they are not a member of unless the
//     "Owners can open private channels" switch is on. Public channels, administration and the audit trail are unaffected.
//  2. An archived channel is read-only for the paths the first Phase 4 pass missed: editing or deleting your own
//     message, the topic, channel links and scheduled messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let pool; let server; let baseUrl; let config;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'owner-access-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, superadmin = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, `${name}@x.test`, 'x', superadmin])).rows[0].id;
  ids.owner = await user('oa-owner', true);
  ids.alice = await user('oa-alice');
  ids.bob = await user('oa-bob');
  ids.priv = (await admin.query("INSERT INTO channels (name, is_private, created_by) VALUES ('zz-oa-private', TRUE, $1) RETURNING id", [ids.alice])).rows[0].id;
  ids.pub = (await admin.query("INSERT INTO channels (name, is_private, created_by) VALUES ('zz-oa-public', FALSE, $1) RETURNING id", [ids.alice])).rows[0].id;
  for (const channel of [ids.priv, ids.pub]) {
    await admin.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'moderator'), ($1, $3, 'member')", [channel, ids.alice, ids.bob]);
  }
  await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'private words')", [ids.priv, ids.alice]);
  await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'public words')", [ids.pub, ids.alice]);
  const app = express();
  app.use(express.json());
  app.use('/api/channels', require('../src/routes/channels'));
  app.use('/api/channels', require('../src/routes/channelLinks'));
  app.use('/api/channels', require('../src/routes/channelAccessPolicies'));
  app.use('/api/channels', require('../src/routes/channelPermissions'));
  app.use('/api/messages', require('../src/routes/messages'));
  app.use('/api/messages', require('../src/routes/messageEdits'));
  app.use('/api/search', require('../src/routes/search'));
  app.use('/api/saved', require('../src/routes/saved'));
  app.use('/api/activity', require('../src/routes/activity'));
  app.use('/api/scheduled', require('../src/routes/scheduled'));
  app.use('/api/admin', require('../src/routes/admin'));
  app.use('/api/moderation', require('../src/routes/moderation'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

const token = (userId) => jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET);
async function request(userId, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token(userId)}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let json = null; try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}
const post = (id, path, body) => request(id, path, { method: 'POST', body: JSON.stringify(body) });
const put = (id, path, body) => request(id, path, { method: 'PUT', body: JSON.stringify(body) });

test('an Owner cannot open private channels they are not in, until the switch is turned on', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const settingOff = (await admin.query('SELECT owner_private_channel_access AS on FROM moderation_settings WHERE id = 1')).rows[0].on;
  assert.equal(settingOff, false, 'off by default');

  // reading
  assert.equal((await request(ids.owner, `/api/channels/${ids.priv}`)).status, 403);
  assert.equal((await request(ids.owner, `/api/messages/${ids.priv}`)).status, 403);
  const search = await request(ids.owner, '/api/search?q=words');
  assert.ok(!JSON.stringify(search.json).includes('private words'), 'search does not return private content');
  const listed = await request(ids.owner, '/api/channels');
  const names = (listed.json.channels || []).map((c) => c.name);
  assert.ok(!names.includes('zz-oa-private'), 'private channel is not in the channel list');
  assert.ok(names.includes('zz-oa-public'), 'public channels are unaffected');
  assert.equal((await request(ids.owner, `/api/messages/${ids.pub}`)).status, 200, 'public channel history still opens');
  // joining (the old route let an Owner walk into any private channel)
  assert.equal((await post(ids.owner, `/api/channels/${ids.priv}/join`, {})).status, 403);
  assert.equal((await admin.query('SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2', [ids.priv, ids.owner])).rows.length, 0);
  // an ordinary member is unaffected
  assert.equal((await request(ids.bob, `/api/messages/${ids.priv}`)).status, 200);

  // administration without content access
  const managers = await request(ids.owner, `/api/moderation/channels/${ids.priv}/managers`);
  assert.equal(managers.status, 200, 'an Owner can still see and manage who manages a private channel');

  // the switch: Owner only, audited
  assert.equal((await put(ids.bob, '/api/admin/owner-private-access', { enabled: true })).status, 403, 'members cannot flip it');
  assert.equal((await put(ids.owner, '/api/admin/owner-private-access', { enabled: 'yes' })).status, 400);
  assert.equal((await put(ids.owner, '/api/admin/owner-private-access', { enabled: true })).status, 200);
  assert.equal((await request(ids.owner, '/api/admin/owner-private-access')).json.enabled, true);
  assert.equal((await request(ids.owner, `/api/messages/${ids.priv}`)).status, 200, 'on: history opens');
  assert.ok(JSON.stringify((await request(ids.owner, '/api/search?q=words')).json).includes('private words'), 'on: search finds it');
  assert.ok(((await request(ids.owner, '/api/channels')).json.channels || []).some((c) => c.name === 'zz-oa-private'), 'on: listed');

  assert.equal((await put(ids.owner, '/api/admin/owner-private-access', { enabled: false })).status, 200);
  assert.equal((await request(ids.owner, `/api/messages/${ids.priv}`)).status, 403, 'off again: closed');
  const audit = await admin.query("SELECT action FROM moderation_audit_log WHERE action LIKE 'owner_private_access_%' ORDER BY id");
  assert.deepEqual(audit.rows.map((r) => r.action), ['owner_private_access_on', 'owner_private_access_off']);
});

test('while the switch is off an Owner cannot give themselves access to a private channel', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = FALSE WHERE id = 1');
  const dept = (await admin.query("INSERT INTO departments (name) VALUES ('oa-dept') RETURNING id")).rows[0].id;
  await admin.query('UPDATE users SET department_id = $2 WHERE id = $1', [ids.owner, dept]);
  const target = (await admin.query("INSERT INTO channels (name, is_private, created_by) VALUES ('zz-oa-selfgrant', TRUE, $1) RETURNING id", [ids.alice])).rows[0].id;
  await admin.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'moderator')", [target, ids.alice]);
  const member = async () => (await admin.query('SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2', [target, ids.owner])).rows.length;

  assert.equal((await put(ids.owner, `/api/moderation/channels/${target}/members/${ids.owner}`, { role: 'member' })).status, 403, 'Moderation > members, self');
  assert.equal((await put(ids.owner, `/api/channels/${target}/access-policy/invitation`, { userId: ids.owner, confirmHistoryExposure: true })).status, 403, 'direct invitation, self');
  assert.equal((await put(ids.owner, `/api/channels/${target}/access-policy/departments`, { departmentIds: [dept], confirmHistoryExposure: true })).status, 403, 'department grant for their own department');
  assert.equal((await put(ids.owner, `/api/channels/${target}/permissions`, { subjectType: 'department', subjectId: dept, allow: ['view_channel'], deny: [] })).status, 403, 'department view override for their own department');
  assert.equal(await member(), 0, 'no membership was created');
  assert.equal((await request(ids.owner, `/api/messages/${target}`)).status, 403, 'and still no access');

  // administration that does not give the Owner access still works
  const other = (await admin.query("INSERT INTO departments (name) VALUES ('oa-other') RETURNING id")).rows[0].id;
  assert.equal((await put(ids.owner, `/api/channels/${target}/access-policy/departments`, { departmentIds: [other], confirmHistoryExposure: true })).status, 200, 'granting another department is fine');
  // someone else inviting the Owner is allowed: that is a decision by the channel's manager
  assert.equal((await put(ids.alice, `/api/moderation/channels/${target}/members/${ids.owner}`, { role: 'member' })).status, 403, 'managers need workspace permission to add members here');
  assert.equal((await put(ids.alice, `/api/channels/${target}/access-policy/invitation`, { userId: ids.owner, confirmHistoryExposure: true })).status, 200, 'a channel manager invites the Owner');
  assert.equal((await request(ids.owner, `/api/messages/${target}`)).status, 200, 'the invited Owner can read');
  await request(ids.alice, `/api/channels/${target}/access-policy/invitation/${ids.owner}`, { method: 'DELETE' });

  // with the switch on, self-grants are allowed again
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = TRUE WHERE id = 1');
  assert.equal((await put(ids.owner, `/api/moderation/channels/${target}/members/${ids.owner}`, { role: 'member' })).status, 200, 'switch on: allowed');
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = FALSE WHERE id = 1');
});

test('an archived channel refuses message edits and deletes, topic changes, links and scheduling', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const own = (await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'mine') RETURNING id", [ids.pub, ids.bob])).rows[0].id;
  const link = (await post(ids.bob, `/api/channels/${ids.pub}/links`, { url: 'https://example.com/a', title: 'before' })).json.link;
  assert.ok(link && link.id, 'a link can be added before archiving');
  assert.equal((await request(ids.alice, `/api/channels/${ids.pub}`, { method: 'PATCH', body: JSON.stringify({ topic: 'before' }) })).status, 200);

  await admin.query('UPDATE channels SET archived_at = NOW() WHERE id = $1', [ids.pub]);
  const sendAt = new Date(Date.now() + 3600e3).toISOString();
  const refused = {
    'edit own message': await request(ids.bob, `/api/messages/${own}`, { method: 'PATCH', body: JSON.stringify({ content: 'edited' }) }),
    'delete own message': await request(ids.bob, `/api/messages/${own}`, { method: 'DELETE' }),
    'topic': await request(ids.alice, `/api/channels/${ids.pub}`, { method: 'PATCH', body: JSON.stringify({ topic: 'after' }) }),
    'add link': await post(ids.bob, `/api/channels/${ids.pub}/links`, { url: 'https://example.com/b', title: 'after' }),
    'remove link': await request(ids.bob, `/api/channels/${ids.pub}/links/${link.id}`, { method: 'DELETE' }),
    'schedule message': await post(ids.bob, '/api/scheduled', { channelId: ids.pub, content: 'later', sendAt }),
  };
  for (const [what, res] of Object.entries(refused)) assert.equal(res.status, 409, `${what} is refused while archived (got ${res.status})`);
  assert.equal((await admin.query('SELECT content FROM messages WHERE id = $1', [own])).rows[0].content, 'mine');
  assert.equal((await admin.query('SELECT topic FROM channels WHERE id = $1', [ids.pub])).rows[0].topic, 'before');
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM channel_links WHERE channel_id = $1', [ids.pub])).rows[0].n, 1);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE channel_id = $1', [ids.pub])).rows[0].n, 0);
  assert.equal((await request(ids.bob, `/api/messages/${ids.pub}`)).status, 200, 'reading stays allowed');
  assert.equal((await request(ids.bob, `/api/channels/${ids.pub}/links`)).status, 200, 'listing links stays allowed');

  await admin.query('UPDATE channels SET archived_at = NULL WHERE id = $1', [ids.pub]);
  assert.equal((await request(ids.bob, `/api/messages/${own}`, { method: 'PATCH', body: JSON.stringify({ content: 'edited' }) })).status, 200, 'works again once restored');
  assert.equal((await post(ids.bob, '/api/scheduled', { channelId: ids.pub, content: 'later', sendAt })).status, 201);
});
