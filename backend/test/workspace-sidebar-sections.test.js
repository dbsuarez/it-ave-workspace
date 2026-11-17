const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch;
let admin;
let pool;
let server;
let baseUrl;
let config;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'workspace-sections-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  ids.owner = (await admin.query("INSERT INTO users (username, email, password_hash, is_superadmin) VALUES ('section-owner', 'owner@x.test', 'x', TRUE) RETURNING id")).rows[0].id;
  ids.member = (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ('section-member', 'member@x.test', 'x') RETURNING id")).rows[0].id;
  ids.leader = (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ('mis-leader', 'mis-leader@x.test', 'x') RETURNING id")).rows[0].id;
  ids.report = (await admin.query("INSERT INTO users (username, email, password_hash, manager_id) VALUES ('mis-report', 'mis-report@x.test', 'x', $1) RETURNING id", [ids.leader])).rows[0].id;
  ids.grandchild = (await admin.query("INSERT INTO users (username, email, password_hash, manager_id) VALUES ('mis-grandchild', 'mis-grandchild@x.test', 'x', $1) RETURNING id", [ids.report])).rows[0].id;
  ids.channel = (await admin.query("INSERT INTO channels (name) VALUES ('zz-workspace-sections') RETURNING id")).rows[0].id;
  const app = express();
  app.use(express.json());
  app.use('/api/settings', require('../src/routes/settings'));
  app.use('/api/channels', require('../src/routes/channels'));
  app.use('/api/moderation', require('../src/routes/moderation'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test('deleting a team section never deletes its channels or their history', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const section = (await request(ids.leader, '/api/settings/sidebar/team', { method: 'POST', body: JSON.stringify({ name: 'Keep Me' }) })).json.section;
  const made = await admin.query("INSERT INTO channels (name, is_private, team_section_id, created_by) VALUES ('zz-keep-me', TRUE, $1, $2) RETURNING id", [section.id, ids.leader]);
  const channelId = made.rows[0].id;
  await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'history that must survive')", [channelId, ids.leader]);

  const stranger = await request(ids.member, `/api/settings/sidebar/team/${section.id}`, { method: 'DELETE' });
  assert.equal(stranger.status, 403, 'only the leader may delete, and learns nothing about its contents');
  const refused = await request(ids.leader, `/api/settings/sidebar/team/${section.id}`, { method: 'DELETE' });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /still holds 1 channel/);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM channels WHERE id = $1', [channelId])).rows[0].n, 1, 'channel survives the refused delete');

  // Backstop: even a direct delete of the section row (any other code path) must not cascade to the channel.
  await admin.query('DELETE FROM team_sidebar_sections WHERE id = $1', [section.id]);
  const after = await admin.query('SELECT team_section_id FROM channels WHERE id = $1', [channelId]);
  assert.equal(after.rows.length, 1, 'channel still exists');
  assert.equal(after.rows[0].team_section_id, null, 'channel is detached from the section, not deleted');
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = $1', [channelId])).rows[0].n, 1, 'history intact');

  // An empty section can still be removed through the API.
  const empty = (await request(ids.leader, '/api/settings/sidebar/team', { method: 'POST', body: JSON.stringify({ name: 'Empty' }) })).json.section;
  const removed = await request(ids.leader, `/api/settings/sidebar/team/${empty.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  await admin.query('DELETE FROM channels WHERE id = $1', [channelId]);
});

test('an upgraded database loses the cascading team-section constraint', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const kind = async () => (await admin.query(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'channels'::regclass AND contype = 'f' AND confrelid = 'team_sidebar_sections'::regclass`)).rows.map((r) => r.confdeltype);
  assert.deepEqual(await kind(), ['n'], 'fresh schema: SET NULL');
  // Recreate the old cascading constraint, then run every migration again as a restart would.
  await admin.query('ALTER TABLE channels DROP CONSTRAINT channels_team_section_id_fkey');
  await admin.query('ALTER TABLE channels ADD CONSTRAINT channels_team_section_id_fkey FOREIGN KEY (team_section_id) REFERENCES team_sidebar_sections(id) ON DELETE CASCADE');
  assert.deepEqual(await kind(), ['c']);
  await scratch.applyMigrations(admin);
  assert.deepEqual(await kind(), ['n'], 'migration converts cascade to SET NULL');
  await scratch.applyMigrations(admin);
  assert.deepEqual(await kind(), ['n'], 'and is safe to run again');
});

test('team leaders create team-only sections and channels for their direct reports', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const created = await request(ids.leader, '/api/settings/sidebar/team', {
    method: 'POST', body: JSON.stringify({ name: 'MIS Only' }),
  });
  assert.equal(created.status, 201);
  const sectionId = created.json.section.id;

  // Team leadership, not the workspace-wide create_channels permission, authorizes this channel.
  await admin.query("UPDATE roles SET permissions = array_remove(permissions, 'create_channels') WHERE builtin_key = 'everyone'");
  const channel = await request(ids.leader, '/api/channels', {
    method: 'POST', body: JSON.stringify({ name: 'zz-mis-only', teamSectionId: sectionId }),
  });
  await admin.query("UPDATE roles SET permissions = array_append(permissions, 'create_channels') WHERE builtin_key = 'everyone' AND NOT ('create_channels' = ANY(permissions))");
  assert.equal(channel.status, 201);
  assert.equal(Number(channel.json.channel.teamSectionId), Number(sectionId));

  const leaderView = await request(ids.leader, '/api/settings/sidebar');
  assert.equal(leaderView.json.layout.teamSections[0].editable, true);
  assert.deepEqual(leaderView.json.layout.teamSections[0].channelIds, [channel.json.channel.id]);

  const reportView = await request(ids.report, '/api/settings/sidebar');
  assert.equal(reportView.json.layout.teamSections[0].editable, false);
  // A grandchild can be authorized for the channel independently of their
  // reporting line, but must inherit the original section across both levels.
  const grandchildInvite = await request(ids.leader, `/api/moderation/channels/${channel.json.channel.id}/members/${ids.grandchild}`, {
    method: 'PUT', body: JSON.stringify({ role: 'member' }),
  });
  assert.equal(grandchildInvite.status, 200);
  const grandchildView = await request(ids.grandchild, '/api/settings/sidebar');
  assert.equal(grandchildView.status, 200);
  assert.ok(grandchildView.json.layout.teamSections.some((section) =>
    section.name === 'MIS Only' && section.channelIds.some((id) => Number(id) === Number(channel.json.channel.id))
    && section.editable === false));
  const grandchildChannels = await request(ids.grandchild, '/api/channels/my');
  assert.ok(grandchildChannels.json.channels.some((item) => Number(item.id) === Number(channel.json.channel.id)));

  // A Superadmin outside the reporting chain gets no placement for a private team channel they cannot open
  // (the "Owners can open private channels" switch is off by default)...
  const ownerBlind = await request(ids.owner, '/api/settings/sidebar');
  assert.equal(ownerBlind.status, 200);
  assert.ok(!ownerBlind.json.layout.teamSections.some((entry) =>
    entry.channelIds.some((id) => Number(id) === Number(channel.json.channel.id))), 'no placement without access');
  // ...and receives the same shared Section placement once the switch gives their account access.
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = TRUE WHERE id = 1');
  const ownerView = await request(ids.owner, '/api/settings/sidebar');
  assert.equal(ownerView.status, 200);
  const ownerSection = ownerView.json.layout.teamSections.find((entry) =>
    entry.name === 'MIS Only' && entry.channelIds.some((id) => Number(id) === Number(channel.json.channel.id)));
  assert.ok(ownerSection, 'Superadmin receives shared Team Section outside reporting hierarchy');
  assert.equal(ownerSection.editable, false);
  assert.equal(ownerView.json.layout.inheritedSections.flatMap((entry) => entry.channelIds)
    .filter((id) => Number(id) === Number(channel.json.channel.id)).length, 0,
  'team channel is not duplicated as an inherited personal section');
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = FALSE WHERE id = 1');

  const reportChannels = await request(ids.report, '/api/channels/my');
  assert.ok(reportChannels.json.channels.some((item) => Number(item.id) === Number(channel.json.channel.id)));

  const invited = await request(ids.leader, `/api/moderation/channels/${channel.json.channel.id}/members/${ids.member}`, {
    method: 'PUT', body: JSON.stringify({ role: 'member' }),
  });
  assert.equal(invited.status, 200);
  const invitedMembership = await admin.query(
    'SELECT membership_source FROM channel_members WHERE channel_id = $1 AND user_id = $2',
    [channel.json.channel.id, ids.member]
  );
  assert.equal(invitedMembership.rows[0].membership_source, 'invited');
  const invitedChannels = await request(ids.member, '/api/channels/my');
  assert.ok(invitedChannels.json.channels.some((item) => Number(item.id) === Number(channel.json.channel.id)));

  const protectedReport = await request(ids.leader, `/api/moderation/channels/${channel.json.channel.id}/members/${ids.report}`, { method: 'DELETE' });
  assert.equal(protectedReport.status, 409);
  const removedInvite = await request(ids.leader, `/api/moderation/channels/${channel.json.channel.id}/members/${ids.member}`, { method: 'DELETE' });
  assert.equal(removedInvite.status, 200);
  assert.equal((await admin.query('SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channel.json.channel.id, ids.member])).rows.length, 0);

  const outsiderView = await request(ids.member, '/api/settings/sidebar');
  assert.deepEqual(outsiderView.json.layout.teamSections, []);

  const forbidden = await request(ids.report, '/api/channels', {
    method: 'POST', body: JSON.stringify({ name: 'zz-mis-report-created', teamSectionId: sectionId }),
  });
  assert.equal(forbidden.status, 403);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

function token(userId) {
  return jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET);
}

async function request(userId, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token(userId)}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { status: res.status, json: await res.json() };
}

test('workspace sections are Owner-managed, visible to everyone, and locked out of personal layouts', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const layout = { sections: [{ id: 'company', name: 'Company', channelIds: [ids.channel] }] };
  const saved = await request(ids.owner, '/api/settings/sidebar/workspace', { method: 'PUT', body: JSON.stringify({ layout }) });
  assert.equal(saved.status, 200);
  // The server always prepends the built-in OFFICIAL section (holding the default channels).
  const savedSections = saved.json.layout.sections;
  assert.equal(savedSections.length, 2);
  assert.equal(savedSections[0].id, 'builtin-official');
  assert.equal(savedSections[0].builtIn, true);
  assert.ok(Array.isArray(savedSections[0].channelIds));
  assert.deepEqual(savedSections[1], layout.sections[0]);

  const memberView = await request(ids.member, '/api/settings/sidebar');
  assert.equal(memberView.status, 200);
  const memberSections = memberView.json.layout.workspaceSections;
  assert.equal(memberSections.length, 2);
  assert.equal(memberSections[0].id, 'builtin-official');
  assert.equal(memberSections[0].builtIn, true);
  assert.deepEqual(memberSections[1], layout.sections[0]);
  assert.equal(memberView.json.layout.canManageWorkspaceSections, false);

  const forbidden = await request(ids.member, '/api/settings/sidebar/workspace', { method: 'PUT', body: JSON.stringify({ layout: { sections: [] } }) });
  assert.equal(forbidden.status, 403);

  const personalMove = await request(ids.member, '/api/settings/sidebar', {
    method: 'PUT',
    body: JSON.stringify({ layout: { sections: [{ id: 'mine', name: 'Mine', channelIds: [ids.channel] }] } }),
  });
  assert.equal(personalMove.status, 400);
  assert.match(personalMove.json.error, /Workspace section channels/);
});
