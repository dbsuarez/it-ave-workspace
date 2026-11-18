// /announce: a shared command, only in channels tagged "announcements", only with the announce permission,
// always previewed first, and posted as a normal message with kind 'announcement'.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config;
const ids = {};
const emitted = [];
const fakeIo = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
let sequence = 0;

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'command-announce-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const addUser = async (name, type = 'member', superadmin = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, `${name}@x.test`, 'x', type, superadmin])).rows[0].id;
  ids.owner = await addUser('an-owner', 'member', true);
  ids.plain = await addUser('an-plain');
  ids.announcer = await addUser('an-announcer');
  ids.guest = await addUser('an-guest', 'guest');
  ids.banned = await addUser('an-banned');
  ids.timed = await addUser('an-timed');
  const role = (await admin.query("INSERT INTO roles (name, permissions, position) VALUES ('an-announcers', ARRAY['announce'], 100) RETURNING id")).rows[0].id;
  await admin.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.announcer, role]);
  ids.tagged = (await admin.query("INSERT INTO channels (name, is_private, command_scope) VALUES ('an-announce', FALSE, 'announcements') RETURNING id")).rows[0].id;
  ids.untagged = (await admin.query("INSERT INTO channels (name, is_private) VALUES ('an-plain', FALSE) RETURNING id")).rows[0].id;
  ids.personal = (await admin.query("INSERT INTO channels (name, is_personal, created_by) VALUES ('an-personal', TRUE, $1) RETURNING id", [ids.owner])).rows[0].id;
  ids.hr = (await admin.query("SELECT id FROM channels WHERE command_scope = 'hr-inquiry'")).rows[0].id;
  for (const channel of [ids.tagged, ids.untagged]) {
    for (const user of [ids.owner, ids.plain, ids.announcer, ids.guest, ids.banned, ids.timed]) {
      await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channel, user]);
    }
  }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = fakeIo; next(); });
  app.use('/api/commands', require('../src/routes/commands'));
  app.use('/api/messages', require('../src/routes/messages'));
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

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
async function call(userId, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const run = (userId, channelId, command) => call(userId, 'POST', '/api/commands/execute', { channelId, command, requestId: `a${sequence++}` });
const confirm = (userId, channelId, token) => call(userId, 'POST', '/api/commands/confirm', { channelId, token });
const announcements = async (channelId) => (await admin.query("SELECT content, kind FROM messages WHERE channel_id = $1 AND kind = 'announcement'", [channelId])).rows;
// a fresh tagged channel so tests do not depend on each other
async function taggedChannel(members) {
  sequence += 1;
  const id = (await admin.query("INSERT INTO channels (name, command_scope) VALUES ($1, 'announcements') RETURNING id", [`an-t${sequence}`])).rows[0].id;
  for (const user of members) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [id, user]);
  return id;
}

test('announce is a permission in the catalogue', () => {
  const { PERMISSIONS, PERMISSION_KEYS } = require('../src/permissions');
  assert.ok(PERMISSION_KEYS.includes('announce'));
  assert.match(PERMISSIONS.find((p) => p.key === 'announce').label, /announcements/i);
});

test('/announce is refused outside tagged channels, without the permission, and for guests', async (t) => {
  if (skip(t)) return;
  assert.equal((await run(ids.owner, ids.untagged, '/announce hello')).status, 404, 'untagged channel');
  assert.equal((await run(ids.owner, ids.hr, '/announce hello')).status, 404, 'the HR channel');
  assert.equal((await run(ids.owner, ids.personal, '/announce hello')).status, 404, 'a personal channel');
  const plain = await run(ids.plain, ids.tagged, '/announce hello');
  assert.equal(plain.status, 403, 'a member without the announce permission');
  assert.equal((await run(ids.guest, ids.tagged, '/announce hello')).status, 403, 'a guest');
  assert.equal((await announcements(ids.tagged)).length, 0);
  const listed = (await call(ids.plain, 'GET', `/api/commands?channelId=${ids.tagged}`)).json.commands.map((c) => c.name);
  assert.ok(!listed.includes('announce'), 'not offered to someone who cannot use it');
  const ownerListed = (await call(ids.owner, 'GET', `/api/commands?channelId=${ids.tagged}`)).json.commands.map((c) => c.name);
  assert.ok(ownerListed.includes('announce'));
});

test('an Owner or a role holder gets a preview with the audience size, and confirming posts one announcement', async (t) => {
  if (skip(t)) return;
  const channel = await taggedChannel([ids.owner, ids.announcer, ids.plain]);
  for (const sender of [ids.owner, ids.announcer]) {
    const preview = await run(sender, channel, '/announce Office closed on Friday');
    assert.equal(preview.status, 200);
    assert.equal(preview.json.kind, 'confirm');
    assert.equal(preview.json.title, 'Post announcement');
    assert.equal(preview.json.confirmLabel, 'Post announcement');
    assert.match(preview.json.data.message, /3 members/);
    assert.match(preview.json.data.message, /Office closed on Friday/);
    assert.equal((await announcements(channel)).length, sender === ids.owner ? 0 : 1, 'a preview alone posts nothing');
    const done = await confirm(sender, channel, preview.json.token);
    assert.equal(done.status, 200);
  }
  const posted = await announcements(channel);
  assert.equal(posted.length, 2);
  assert.deepEqual([...new Set(posted.map((p) => p.content))], ['Office closed on Friday']);
  const event = emitted.filter((e) => e.room === `channel_${channel}` && e.event === 'new_message').pop();
  assert.equal(event.payload.kind, 'announcement');
});

test('line breaks and spacing in an announcement are kept exactly as typed', async (t) => {
  if (skip(t)) return;
  const channel = await taggedChannel([ids.owner]);
  const text = 'Line one\n\nLine  two with  double spaces\n- bullet';
  const preview = await run(ids.owner, channel, `/announce ${text}`);
  assert.equal(preview.json.kind, 'confirm');
  assert.ok(preview.json.data.message.endsWith(text), 'the preview shows it as typed');
  await confirm(ids.owner, channel, preview.json.token);
  assert.equal((await announcements(channel))[0].content, text);
});

test('previewing an announcement does not use up the slow-mode slot, so confirming right away works', async (t) => {
  if (skip(t)) return;
  const channel = await taggedChannel([ids.owner, ids.announcer]);
  await admin.query('UPDATE channels SET slowmode_seconds = 30 WHERE id = $1', [channel]);
  const preview = await run(ids.announcer, channel, '/announce Slow mode is on here');
  assert.equal(preview.json.kind, 'confirm');
  const done = await confirm(ids.announcer, channel, preview.json.token);
  assert.equal(done.status, 200, 'confirmed immediately: ' + JSON.stringify(done.json));
  assert.equal((await announcements(channel)).length, 1);
  const second = await run(ids.announcer, channel, '/announce Another one straight away');
  const again = await confirm(ids.announcer, channel, second.json.token);
  assert.equal(again.status, 429, 'but slow mode still applies to the announcement itself');
});

test('empty and over-long announcements are refused before any preview', async (t) => {
  if (skip(t)) return;
  const channel = await taggedChannel([ids.owner]);
  assert.equal((await run(ids.owner, channel, '/announce')).status, 400);
  assert.equal((await run(ids.owner, channel, `/announce ${'a'.repeat(2000)}`)).status, 400);
  const ok = await run(ids.owner, channel, `/announce ${'a'.repeat(1980)}`);
  assert.equal(ok.json.kind, 'confirm', 'close to the limit still previews');
});

test('an archived channel, a ban or a timeout stops an announcement, early or at confirm', async (t) => {
  if (skip(t)) return;
  const archived = await taggedChannel([ids.owner]);
  await admin.query('UPDATE channels SET archived_at = NOW() WHERE id = $1', [archived]);
  assert.equal((await run(ids.owner, archived, '/announce nope')).status, 409, 'refused at the first step when archived');

  const lateArchive = await taggedChannel([ids.owner]);
  const preview = await run(ids.owner, lateArchive, '/announce changed my mind');
  await admin.query('UPDATE channels SET archived_at = NOW() WHERE id = $1', [lateArchive]);
  assert.ok((await confirm(ids.owner, lateArchive, preview.json.token)).status >= 400, 'archived after the preview');
  assert.equal((await announcements(lateArchive)).length, 0);

  const timedChannel = await taggedChannel([ids.owner, ids.announcer]);
  await admin.query("INSERT INTO channel_timeouts (channel_id, user_id, expires_at, reason) VALUES ($1, $2, NOW() + INTERVAL '1 hour', 'test')", [timedChannel, ids.announcer]);
  assert.ok((await run(ids.announcer, timedChannel, '/announce while timed out')).status >= 400);
  const bannedChannel = await taggedChannel([ids.owner, ids.announcer]);
  await admin.query("INSERT INTO channel_bans (channel_id, user_id, reason) VALUES ($1, $2, 'test')", [bannedChannel, ids.announcer]);
  assert.ok((await run(ids.announcer, bannedChannel, '/announce while banned')).status >= 400);
  assert.equal((await announcements(timedChannel)).length + (await announcements(bannedChannel)).length, 0);
});

test('announcement text is stored verbatim and history carries kind', async (t) => {
  if (skip(t)) return;
  const channel = await taggedChannel([ids.owner]);
  const text = '<script>alert(1)</script> & "quotes"';
  const preview = await run(ids.owner, channel, `/announce ${text}`);
  await confirm(ids.owner, channel, preview.json.token);
  assert.equal((await announcements(channel))[0].content, text);
  const history = await call(ids.owner, 'GET', `/api/messages/${channel}`);
  assert.equal(history.json.messages[0].kind, 'announcement');
  assert.equal(history.json.messages[0].content, text);
  const normal = (await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'plain') RETURNING kind", [channel, ids.owner])).rows[0];
  assert.equal(normal.kind, 'message', 'ordinary messages keep the default kind');
});

test('channels are tagged and untagged through Moderation, with permission, audit and protection of HR and personal channels', async (t) => {
  if (skip(t)) return;
  const patch = (userId, channelId, body) => call(userId, 'PATCH', `/api/moderation/channels/${channelId}/command-scope`, body);
  assert.equal((await patch(ids.plain, ids.untagged, { scope: 'announcements' })).status, 403, 'needs manage_channels');
  assert.equal((await patch(ids.owner, ids.untagged, { scope: 'announcements' })).status, 200);
  assert.equal((await admin.query('SELECT command_scope FROM channels WHERE id = $1', [ids.untagged])).rows[0].command_scope, 'announcements');
  const audit = await admin.query("SELECT details FROM moderation_audit_log WHERE action = 'channel_command_scope_changed' AND channel_id = $1", [ids.untagged]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].details.scope, 'announcements');
  assert.equal((await patch(ids.owner, ids.untagged, { scope: null })).status, 200);
  assert.equal((await admin.query('SELECT command_scope FROM channels WHERE id = $1', [ids.untagged])).rows[0].command_scope, null);
  assert.equal((await patch(ids.owner, ids.untagged, { scope: 'hr-inquiry' })).status, 400, 'cannot hand out the HR tag');
  assert.equal((await patch(ids.owner, ids.untagged, { scope: 'anything-else' })).status, 400);
  assert.equal((await patch(ids.owner, ids.hr, { scope: null })).status, 409, 'the HR channel keeps its tag');
  assert.equal((await patch(ids.owner, ids.personal, { scope: 'announcements' })).status, 409, 'personal channels cannot be tagged');
});

test('the built-in #announcements channel carries the tag', async (t) => {
  if (skip(t)) return;
  const { ensureDefaultChannels } = require('../src/defaultChannels');
  await ensureDefaultChannels({ query: (...args) => admin.query(...args) });
  assert.equal((await admin.query("SELECT command_scope FROM channels WHERE name = 'announcements'")).rows[0].command_scope, 'announcements');
  // an existing database where it was created untagged is fixed by the migrations
  await admin.query("UPDATE channels SET command_scope = NULL WHERE name = 'announcements'");
  await scratch.applyMigrations(admin);
  assert.equal((await admin.query("SELECT command_scope FROM channels WHERE name = 'announcements'")).rows[0].command_scope, 'announcements');
});
