// Built-in channels: an Owner can mark a channel built-in. While marked, everyone is in it and nobody can leave or remove
// anyone, and it cannot be renamed, archived or deleted. Turn the mark off and it is an ordinary channel again.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config; let defaults;
const ids = {};
const emitted = [];
const fakeIo = { emit: (event, payload) => emitted.push({ event, payload }), to: () => ({ emit() {} }), in: () => ({ fetchSockets: async () => [] }) };

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'built-in-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  defaults = require('../src/defaultChannels');
  const add = async (username, { superadmin = false, type = 'member' } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin, account_type) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [username, `${username}@x.test`, 'x', superadmin, type])).rows[0].id;
  ids.owner = await add('bi-owner', { superadmin: true });
  ids.ann = await add('bi-ann');
  ids.bob = await add('bi-bob');
  ids.guest = await add('bi-guest', { type: 'guest' });
  ids.gone = await add('bi-gone');
  await admin.query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [ids.gone]);
  await defaults.ensureDefaultChannels(admin);
  const mk = async (name, extra = '') => (await admin.query(`INSERT INTO channels (name, created_by ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1, $2 ${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`, [name, ids.ann])).rows[0].id;
  ids.ops = await mk('bi-ops');
  ids.second = await mk('bi-second');
  ids.priv = await mk('bi-private', 'is_private=TRUE');
  ids.archived = await mk('bi-archived', 'archived_at=NOW()');
  ids.forum = (await admin.query("INSERT INTO channels (name, kind, is_private) VALUES ('dept-bi', 'forum', TRUE) RETURNING id")).rows[0].id;
  ids.personal = (await admin.query("INSERT INTO channels (name, is_personal, is_private, created_by) VALUES ('bi-personal', TRUE, TRUE, $1) RETURNING id", [ids.ann])).rows[0].id;
  await admin.query('INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3)', [ids.ops, ids.ann, 'moderator']);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = fakeIo; next(); });
  app.use('/api/channels', require('../src/routes/channels'));
  app.use('/api/moderation', require('../src/routes/moderation'));
  app.use('/api/settings', require('../src/routes/settings'));
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
const mark = (who, channel, builtIn) => call(who, 'PATCH', `/api/channels/${channel}/builtin`, { builtIn });
const official = async () => (await admin.query('SELECT workspace_sidebar_layout FROM moderation_settings WHERE id = 1')).rows[0].workspace_sidebar_layout.sections[0].channelIds.map(Number);
const memberCount = async (channel) => (await admin.query('SELECT COUNT(*)::int AS n FROM channel_members WHERE channel_id = $1', [channel])).rows[0].n;
const activeMembers = async () => (await admin.query("SELECT COUNT(*)::int AS n FROM users WHERE account_type = 'member' AND deactivated_at IS NULL")).rows[0].n;

test('the four required channels are built-in already', async (t) => {
  if (skip(t)) return;
  const rows = (await admin.query("SELECT name FROM channels WHERE builtin = TRUE ORDER BY name")).rows.map((r) => r.name);
  assert.deepEqual(rows, ['announcements', 'general', 'rules', 'welcome']);
  const welcome = (await admin.query("SELECT id FROM channels WHERE name = 'welcome'")).rows[0].id;
  assert.equal((await mark(ids.owner, welcome, false)).status, 409, 'they are required by the app');
});

test('only an Owner can change the mark', async (t) => {
  if (skip(t)) return;
  assert.equal((await mark(ids.ann, ids.ops, true)).status, 403, 'even the channel’s own creator and moderator');
  assert.equal((await mark(ids.bob, ids.ops, true)).status, 403);
  assert.equal((await admin.query('SELECT builtin FROM channels WHERE id = $1', [ids.ops])).rows[0].builtin, false);
});

test('marking makes the channel public, puts every active member in it, lists it in OFFICIAL after the four, and is audited', async (t) => {
  if (skip(t)) return;
  const done = await mark(ids.owner, ids.ops, true);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const row = (await admin.query('SELECT builtin, available_to_all, is_private FROM channels WHERE id = $1', [ids.ops])).rows[0];
  assert.deepEqual(row, { builtin: true, available_to_all: true, is_private: false });
  assert.equal(await memberCount(ids.ops), await activeMembers() + 0, 'everyone active, and no guests or deactivated people');
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM channel_members WHERE channel_id = $1 AND user_id = ANY($2)', [ids.ops, [ids.guest, ids.gone]])).rows[0].n, 0);
  const layout = await official();
  const names = (await admin.query('SELECT id, name FROM channels WHERE id = ANY($1)', [layout])).rows;
  const order = layout.map((id) => (names.find((n) => Number(n.id) === id) || {}).name);
  assert.deepEqual(order.filter((n) => ['welcome', 'rules', 'announcements', 'general', 'bi-ops'].includes(n)), ['welcome', 'rules', 'announcements', 'general', 'bi-ops']);
  assert.ok((await admin.query("SELECT 1 FROM moderation_audit_log WHERE channel_id = $1 AND action = 'channel_builtin_on' AND actor_id = $2", [ids.ops, ids.owner])).rows.length);
  assert.ok(emitted.some((e) => e.event === 'channel_availability_updated'), 'clients are told to reload');
  const listed = (await call(ids.bob, 'GET', '/api/channels/my')).json.channels.find((c) => c.id === ids.ops);
  assert.equal(listed.builtIn, true);
});

test('while built-in: no rename, no archive, no delete, no turning off "visible to all", nobody can be removed', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.owner, 'PATCH', `/api/channels/${ids.ops}/name`, { name: 'bi-ops-renamed' })).status, 409);
  assert.equal((await call(ids.owner, 'POST', `/api/moderation/channels/${ids.ops}/archive`, { confirmation: 'ARCHIVE CHANNEL' })).status, 409);
  assert.equal((await call(ids.owner, 'DELETE', `/api/moderation/channels/${ids.ops}`, { confirmation: 'PERMANENTLY DELETE CHANNEL' })).status, 409);
  assert.equal((await call(ids.owner, 'PATCH', `/api/channels/${ids.ops}/availability`, { availableToAll: false })).status, 409);
  assert.equal((await call(ids.owner, 'DELETE', `/api/moderation/channels/${ids.ops}/members/${ids.bob}`)).status, 409);
  assert.equal((await admin.query("SELECT name, archived_at FROM channels WHERE id = $1", [ids.ops])).rows[0].archived_at, null);
  assert.equal(await memberCount(ids.ops), await activeMembers());
});

test('a new member joins every built-in channel automatically', async (t) => {
  if (skip(t)) return;
  const fresh = (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ('bi-fresh', 'bi-fresh@x.test', 'x') RETURNING id")).rows[0].id;
  await defaults.joinBuiltInChannels((...a) => admin.query(...a), fresh);
  const joined = (await admin.query('SELECT c.name FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE cm.user_id = $1 AND c.builtin ORDER BY c.name', [fresh])).rows.map((r) => r.name);
  assert.deepEqual(joined, ['announcements', 'bi-ops', 'general', 'rules', 'welcome']);
});

test('turn the mark off and it is an ordinary channel again: removed from OFFICIAL, members stay, it can be renamed, archived and deleted', async (t) => {
  if (skip(t)) return;
  const off = await mark(ids.owner, ids.ops, false);
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal((await admin.query('SELECT builtin FROM channels WHERE id = $1', [ids.ops])).rows[0].builtin, false);
  assert.ok(!(await official()).includes(ids.ops), 'no longer in OFFICIAL');
  assert.ok(await memberCount(ids.ops) > 0, 'people stay in it');
  assert.ok((await admin.query("SELECT 1 FROM moderation_audit_log WHERE channel_id = $1 AND action = 'channel_builtin_off'", [ids.ops])).rows.length);
  assert.equal((await call(ids.owner, 'PATCH', `/api/channels/${ids.ops}/name`, { name: 'bi-ops-renamed' })).status, 200);
  assert.equal((await call(ids.owner, 'POST', `/api/moderation/channels/${ids.ops}/archive`, { confirmation: 'ARCHIVE CHANNEL' })).status, 200);
  assert.equal((await call(ids.owner, 'DELETE', `/api/moderation/channels/${ids.ops}`, { confirmation: 'PERMANENTLY DELETE CHANNEL' })).status, 200);
});

test('what cannot be made built-in: private, personal, forum and archived channels', async (t) => {
  if (skip(t)) return;
  for (const [id, label] of [[ids.priv, 'private'], [ids.personal, 'personal'], [ids.forum, 'forum'], [ids.archived, 'archived']]) {
    const res = await mark(ids.owner, id, true);
    assert.equal(res.status, 409, label);
    assert.equal((await admin.query('SELECT builtin FROM channels WHERE id = $1', [id])).rows[0].builtin, false, label);
  }
  assert.equal((await mark(ids.owner, 999999, true)).status, 404);
  assert.equal((await call(ids.owner, 'PATCH', `/api/channels/${ids.second}/builtin`, { builtIn: 'yes' })).status, 400);
});

test('an Owner can create a channel as built-in; anyone else asking for it is refused', async (t) => {
  if (skip(t)) return;
  const created = await call(ids.owner, 'POST', '/api/channels', { name: 'bi-created', builtIn: true });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const row = (await admin.query("SELECT id, builtin, available_to_all, is_private FROM channels WHERE name = 'bi-created'")).rows[0];
  assert.deepEqual([row.builtin, row.available_to_all, row.is_private], [true, true, false]);
  assert.equal(await memberCount(row.id), await activeMembers());
  assert.ok((await official()).includes(row.id));
  assert.equal((await call(ids.ann, 'POST', '/api/channels', { name: 'bi-sneaky', builtIn: true })).status, 403);
  assert.equal((await admin.query("SELECT 1 FROM channels WHERE name = 'bi-sneaky'")).rows.length, 0);
});

test('restarting keeps an Owner-made built-in channel built-in and still in OFFICIAL', async (t) => {
  if (skip(t)) return;
  await defaults.ensureDefaultChannels(admin);
  await defaults.ensureDefaultChannels(admin);
  const id = (await admin.query("SELECT id FROM channels WHERE name = 'bi-created'")).rows[0].id;
  assert.equal((await admin.query('SELECT builtin FROM channels WHERE id = $1', [id])).rows[0].builtin, true);
  assert.ok((await official()).includes(id));
});

// ---- reordering the built-in channels (Owner only; the order is remembered)
const builtInIds = async () => (await admin.query('SELECT id FROM channels WHERE builtin = TRUE AND archived_at IS NULL')).rows.map((r) => Number(r.id));
const builtInOrder = async () => { const mine = new Set(await builtInIds()); return (await official()).filter((id) => mine.has(id)); };
const reorder = (who, channelIds) => call(who, 'PUT', '/api/settings/sidebar/official', { channelIds });

test('an Owner can put the built-in channels in any order; the sidebar reads that order', async (t) => {
  if (skip(t)) return;
  const first = await builtInOrder();
  assert.ok(first.length >= 5, 'the four plus bi-created');
  const reversed = [...first].reverse();
  const done = await reorder(ids.owner, reversed);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual(await builtInOrder(), reversed);
  const seen = (await call(ids.bob, 'GET', '/api/settings/sidebar')).json.layout.workspaceSections[0].channelIds.map(Number);
  assert.deepEqual(seen.filter((id) => reversed.includes(id)), reversed, 'what members see');
});

test('only an Owner can reorder, and the list must hold every built-in channel exactly once', async (t) => {
  if (skip(t)) return;
  const order = await builtInOrder();
  assert.equal((await reorder(ids.ann, order)).status, 403);
  assert.equal((await reorder(ids.owner, order.slice(1))).status, 400, 'one missing');
  assert.equal((await reorder(ids.owner, [...order, ids.second])).status, 400, 'a channel that is not built-in');
  assert.equal((await reorder(ids.owner, [order[0], ...order])).status, 400, 'a repeat');
  assert.equal((await reorder(ids.owner, 'nope')).status, 400);
  assert.deepEqual(await builtInOrder(), order, 'nothing changed');
});

test('the chosen order survives restarts, saving the other sections, a new built-in channel and turning one off', async (t) => {
  if (skip(t)) return;
  const chosen = [...(await builtInOrder())].sort((a, b) => b - a);
  assert.equal((await reorder(ids.owner, chosen)).status, 200);
  await defaults.ensureDefaultChannels(admin);
  assert.deepEqual(await builtInOrder(), chosen, 'a restart keeps it');
  const saved = await call(ids.owner, 'PUT', '/api/settings/sidebar/workspace', { layout: { sections: [{ id: 'extra', name: 'Extra', channelIds: [ids.second] }] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(await builtInOrder(), chosen, 'saving the Owner’s other sections keeps it');
  assert.equal((await mark(ids.owner, ids.second, true)).status, 200);
  assert.deepEqual(await builtInOrder(), [...chosen, ids.second], 'a new built-in channel goes last');
  assert.equal((await mark(ids.owner, ids.second, false)).status, 200);
  assert.deepEqual(await builtInOrder(), chosen, 'turning one off leaves the rest as they were');
});
