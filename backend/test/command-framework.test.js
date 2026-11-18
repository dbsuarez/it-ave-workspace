// The slash-command framework: scopes, per-command permission, guests, discovery, and shared results behind a
// one-time confirm token. Uses throwaway test commands registered here, never the real ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config; let registry; let delivery;
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
  process.env.JWT_SECRET = 'command-framework-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  registry = require('../src/commands/registry');
  delivery = require('../src/messageDelivery');
  const addUser = async (name, type = 'member', superadmin = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, `${name}@x.test`, 'x', type, superadmin])).rows[0].id;
  ids.owner = await addUser('cf-owner', 'member', true);
  ids.guest = await addUser('cf-guest', 'guest');
  ids.general = (await admin.query("INSERT INTO channels (name, is_private) VALUES ('cf-general', FALSE) RETURNING id")).rows[0].id;
  ids.tagged = (await admin.query("INSERT INTO channels (name, is_private, command_scope) VALUES ('cf-tagged', FALSE, 'announcements') RETURNING id")).rows[0].id;
  for (const channel of [ids.general, ids.tagged]) {
    await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)', [channel, ids.owner, ids.guest]);
  }
  const privateCard = (title) => async () => ({ visibility: 'private', kind: 'card', title, data: {}, actions: [] });
  const common = { category: 'general', scopes: [{ type: 'global' }] };
  registry.register({ ...common, name: 't-global', description: 'test global', handler: privateCard('global') });
  registry.register({ ...common, name: 't-any', description: 'test any channel', scopes: [{ type: 'any-channel' }], handler: privateCard('any') });
  registry.register({ ...common, name: 't-tag', description: 'test tagged', scopes: [{ type: 'channel-scope', value: 'announcements' }], handler: privateCard('tag') });
  registry.register({ ...common, name: 't-perm', description: 'test permission', permission: 'manage_workspace', handler: privateCard('perm') });
  registry.register({
    ...common, name: 't-post', description: 'test shared post', usage: '/t-post <text>', visibility: 'shared', scopes: [{ type: 'any-channel' }],
    confirm: { preview: async (ctx, args) => ({ title: 'Post it?', message: args.join(' '), confirmLabel: 'Post' }) },
    handler: async (ctx, args) => {
      await delivery.postChannelMessage(ctx.io, ctx.query, { userId: ctx.userId, channelId: ctx.channelId, content: args.join(' ') });
      return { visibility: 'private', kind: 'card', title: 'Posted', data: { message: 'Posted.' }, actions: [] };
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = fakeIo; next(); });
  app.use('/api/commands', require('../src/routes/commands'));
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
  const response = await fetch(`${baseUrl}/api/commands${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const run = (userId, channelId, command) => call(userId, 'POST', '/execute', { channelId, command, requestId: `r-${sequence++}` });
// A new member (so the per-user rate limit never interferes) who belongs to the given channels.
async function fresh(channels = [ids.general]) {
  sequence += 1;
  const id = (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING id", [`cf-u${sequence}`, `cf-u${sequence}@x.test`])).rows[0].id;
  for (const channel of channels) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channel, id]);
  return id;
}
async function newChannel(members = []) {
  sequence += 1;
  const id = (await admin.query('INSERT INTO channels (name) VALUES ($1) RETURNING id', [`cf-ch${sequence}`])).rows[0].id;
  for (const member of members) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [id, member]);
  return id;
}
const messageCount = async (channelId) => (await admin.query('SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = $1', [channelId])).rows[0].n;

test('global, any-channel and channel-tag scopes decide where a command works', async (t) => {
  if (skip(t)) return;
  const personal = (await admin.query("INSERT INTO channels (name, is_personal, created_by) VALUES ('cf-personal', TRUE, $1) RETURNING id", [ids.owner])).rows[0].id;
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [personal, ids.owner]);
  const user = await fresh([ids.general]);
  assert.equal((await run(user, ids.general, '/t-global')).status, 200, 'global works in an ordinary channel');
  assert.equal((await run(ids.owner, personal, '/t-global')).status, 200, 'global works in a personal channel');
  assert.equal((await run(user, ids.general, '/t-any')).status, 200, 'any-channel works in an ordinary channel');
  const noPersonal = await run(ids.owner, personal, '/t-any');
  assert.equal(noPersonal.status, 404, 'any-channel is refused in a personal channel');
  assert.equal(noPersonal.json.code, 'COMMAND_NOT_AVAILABLE');
  assert.equal((await run(user, ids.general, '/t-tag')).status, 404, 'a tagged command is refused in an untagged channel, called directly');
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.tagged, user]);
  assert.equal((await run(user, ids.tagged, '/t-tag')).status, 200, 'and works in the tagged channel');
  await admin.query("UPDATE channels SET name = 'cf-tagged-renamed' WHERE id = $1", [ids.tagged]);
  assert.equal((await run(user, ids.tagged, '/t-tag')).status, 200, 'renaming the channel does not change access');
  await admin.query("UPDATE channels SET name = 'cf-tagged' WHERE id = $1", [ids.tagged]);
});

test('a command with a catalogue permission needs it, and discovery hides what you cannot run', async (t) => {
  if (skip(t)) return;
  const member = await fresh();
  const denied = await run(member, ids.general, '/t-perm');
  assert.equal(denied.status, 403);
  assert.equal((await run(ids.owner, ids.general, '/t-perm')).status, 200, 'an Owner holds every permission');
  const memberList = (await call(member, 'GET', `?channelId=${ids.general}`)).json.commands.map((c) => c.name);
  assert.ok(memberList.includes('t-global') && memberList.includes('t-any'));
  assert.ok(!memberList.includes('t-perm'), 'a command you lack the permission for is not listed');
  assert.ok(!memberList.includes('t-tag'), 'a command outside its scope is not listed');
  const ownerList = (await call(ids.owner, 'GET', `?channelId=${ids.general}`)).json.commands.map((c) => c.name);
  assert.ok(ownerList.includes('t-perm'));
});

test('guests cannot run commands and get an empty list, not an error', async (t) => {
  if (skip(t)) return;
  assert.equal((await run(ids.guest, ids.general, '/t-global')).status, 403);
  const list = await call(ids.guest, 'GET', `?channelId=${ids.general}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.commands, []);
});

test('listed commands carry category and usage', async (t) => {
  if (skip(t)) return;
  const member = await fresh();
  const rows = (await call(member, 'GET', `?channelId=${ids.general}`)).json.commands;
  const post = rows.find((c) => c.name === 't-post');
  assert.equal(post.category, 'general');
  assert.equal(post.usage, '/t-post <text>');
  assert.equal(rows.find((c) => c.name === 't-global').usage, '/t-global', 'usage defaults to the command name');
});

test('private results never become messages or room broadcasts', async (t) => {
  if (skip(t)) return;
  const channel = await newChannel();
  const user = await fresh([channel]);
  const before = emitted.length;
  assert.equal((await run(user, channel, '/t-global')).status, 200);
  assert.equal(await messageCount(channel), 0);
  assert.equal(emitted.length, before, 'nothing was emitted to any room');
});

test('a shared command previews first, posts exactly once on confirm, and the token is single use', async (t) => {
  if (skip(t)) return;
  const channel = await newChannel();
  const user = await fresh([channel]);
  const preview = await run(user, channel, '/t-post hello team');
  assert.equal(preview.status, 200);
  assert.equal(preview.json.kind, 'confirm');
  assert.equal(preview.json.title, 'Post it?');
  assert.equal(preview.json.data.message, 'hello team');
  assert.equal(preview.json.confirmLabel, 'Post');
  assert.ok(preview.json.token && preview.json.token.length >= 32);
  assert.equal(await messageCount(channel), 0, 'the preview posts nothing');
  const stored = (await admin.query('SELECT token_hash FROM command_pending WHERE user_id = $1', [user])).rows;
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, preview.json.token, 'only a hash of the token is stored');

  const done = await call(user, 'POST', '/confirm', { channelId: channel, token: preview.json.token });
  assert.equal(done.status, 200);
  assert.equal(done.json.title, 'Posted');
  assert.equal(await messageCount(channel), 1);
  assert.equal((await admin.query('SELECT content FROM messages WHERE channel_id = $1', [channel])).rows[0].content, 'hello team');
  assert.ok(emitted.some((e) => e.room === `channel_${channel}` && e.event === 'new_message'), 'the post reached the channel room');
  const audit = await admin.query("SELECT outcome FROM command_audit_log WHERE actor_id = $1 AND command_name = 't-post'", [user]);
  assert.ok(audit.rows.some((r) => r.outcome === 'success'));

  const again = await call(user, 'POST', '/confirm', { channelId: channel, token: preview.json.token });
  assert.equal(again.status, 400, 'a used token is refused');
  assert.equal(await messageCount(channel), 1, 'no second post');
});

test('an expired token, a wrong user and a wrong channel are refused; the right user can still confirm', async (t) => {
  if (skip(t)) return;
  const channel = await newChannel();
  const other = await newChannel();
  const user = await fresh([channel, other]);
  const stranger = await fresh([channel]);
  const preview = await run(user, channel, '/t-post bound');
  const confirm = (who, ch) => call(who, 'POST', '/confirm', { channelId: ch, token: preview.json.token });
  assert.equal((await confirm(stranger, channel)).status, 400, 'another user cannot use it');
  assert.equal((await confirm(user, other)).status, 400, 'another channel cannot use it');
  assert.equal(await messageCount(channel) + await messageCount(other), 0);
  await admin.query("UPDATE command_pending SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [user]);
  assert.equal((await confirm(user, channel)).status, 400, 'an expired token is refused');
  const second = await run(user, channel, '/t-post fresh one');
  assert.equal((await call(user, 'POST', '/confirm', { channelId: channel, token: second.json.token })).status, 200, 'a new token works');
  assert.equal(await messageCount(channel), 1);
});

test('confirming after the channel, the user or their standing changed is refused and posts nothing', async (t) => {
  if (skip(t)) return;
  const scenarios = {
    'channel archived': (channel) => admin.query('UPDATE channels SET archived_at = NOW() WHERE id = $1', [channel]),
    'user banned': (channel, user) => admin.query("INSERT INTO channel_bans (channel_id, user_id, reason) VALUES ($1, $2, 'test')", [channel, user]),
    'user timed out': (channel, user) => admin.query("INSERT INTO channel_timeouts (channel_id, user_id, expires_at, reason) VALUES ($1, $2, NOW() + INTERVAL '1 hour', 'test')", [channel, user]),
    'user removed': (channel, user) => admin.query('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channel, user]),
    'account deactivated': (channel, user) => admin.query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [user]),
  };
  for (const [label, change] of Object.entries(scenarios)) {
    const channel = await newChannel();
    const user = await fresh([channel]);
    const preview = await run(user, channel, '/t-post should not land');
    assert.equal(preview.json.kind, 'confirm', label);
    await change(channel, user);
    const result = await call(user, 'POST', '/confirm', { channelId: channel, token: preview.json.token });
    assert.ok(result.status >= 400, `${label}: confirm is refused (got ${result.status})`);
    assert.equal(await messageCount(channel), 0, `${label}: nothing was posted`);
  }
});

test('confirming with no token, or a malformed one, is a clean 400', async (t) => {
  if (skip(t)) return;
  const user = await fresh();
  assert.equal((await call(user, 'POST', '/confirm', { channelId: ids.general })).status, 400);
  assert.equal((await call(user, 'POST', '/confirm', { channelId: ids.general, token: { $ne: null } })).status, 400);
  assert.equal((await call(user, 'POST', '/confirm', { channelId: ids.general, token: 'x'.repeat(5000) })).status, 400);
});
