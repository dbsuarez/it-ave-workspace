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
  ids.channel = (await admin.query("INSERT INTO channels (name) VALUES ('zz-workspace-sections') RETURNING id")).rows[0].id;
  const app = express();
  app.use(express.json());
  app.use('/api/settings', require('../src/routes/settings'));
  app.use('/api/channels', require('../src/routes/channels'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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
  const reportChannels = await request(ids.report, '/api/channels/my');
  assert.ok(reportChannels.json.channels.some((item) => Number(item.id) === Number(channel.json.channel.id)));

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
  assert.deepEqual(saved.json.layout, layout);

  const memberView = await request(ids.member, '/api/settings/sidebar');
  assert.equal(memberView.status, 200);
  assert.deepEqual(memberView.json.layout.workspaceSections, layout.sections);
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
