// Team Channels and Team Sections are gone (department forums replace them): the data survives as ordinary channels,
// the table and column are removed, and nothing that used them still answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'team-removal-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;

  // a database as it was before this change: the section table and the channel column exist and are in use
  await admin.query(`CREATE TABLE IF NOT EXISTS team_sidebar_sections (id SERIAL PRIMARY KEY, name VARCHAR(40) NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW())`);
  await admin.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS team_section_id INTEGER REFERENCES team_sidebar_sections(id) ON DELETE SET NULL');
  const add = async (username, extra = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, is_superadmin, manager_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [username, `${username}@x.test`, 'x', Boolean(extra.superadmin), extra.manager || null])).rows[0].id;
  ids.owner = await add('tr-owner', { superadmin: true });
  ids.lead = await add('tr-lead');
  ids.ann = await add('tr-ann', { manager: ids.lead });
  ids.newLead = await add('tr-newlead');
  ids.section = (await admin.query("INSERT INTO team_sidebar_sections (name, owner_id) VALUES ('My team', $1) RETURNING id", [ids.lead])).rows[0].id;
  ids.teamChannel = (await admin.query("INSERT INTO channels (name, team_section_id, is_private) VALUES ('tr-team-chat', $1, TRUE) RETURNING id", [ids.section])).rows[0].id;
  await admin.query("INSERT INTO channel_members (channel_id, user_id, role, membership_source) VALUES ($1, $2, 'moderator', 'manual'), ($1, $3, 'member', 'team')", [ids.teamChannel, ids.lead, ids.ann]);
  ids.message = (await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'team message') RETURNING id", [ids.teamChannel, ids.ann])).rows[0].id;
  ids.file = (await admin.query("INSERT INTO files (filename, original_name, size, mime_type, uploaded_by, message_id) VALUES ('stored-team.txt', 'team.txt', 5, 'text/plain', $1, $2) RETURNING id", [ids.ann, ids.message])).rows[0].id;
  // a person whose saved sidebar still names a team section id
  await admin.query("UPDATE users SET sidebar_layout = $2 WHERE id = $1", [ids.ann, JSON.stringify({ sections: [{ id: 'team-1', name: 'Old', channelIds: [ids.teamChannel] }, { id: 's1', name: 'Mine', channelIds: [] }], workspaceCollapsed: ['team-1'] })]);
  ids.privateBefore = (await admin.query('SELECT is_private FROM channels WHERE id = $1', [ids.teamChannel])).rows[0].is_private;

  await scratch.applyMigrations(admin); // the migration under test
  const app = express();
  app.use(express.json());
  app.use('/api/settings', require('../src/routes/settings'));
  app.use('/api/channels', require('../src/routes/channels'));
  app.use('/api/people', require('../src/routes/people'));
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
const rows = async (sql, params) => (await admin.query(sql, params)).rows;

test('the table and the column are gone, and nothing was lost', async (t) => {
  if (skip(t)) return;
  assert.equal((await rows("SELECT 1 FROM information_schema.tables WHERE table_name = 'team_sidebar_sections'")).length, 0);
  assert.equal((await rows("SELECT 1 FROM information_schema.columns WHERE table_name = 'channels' AND column_name = 'team_section_id'")).length, 0);
  assert.equal((await rows('SELECT content FROM messages WHERE id = $1', [ids.message]))[0].content, 'team message');
  assert.equal((await rows('SELECT message_id FROM files WHERE id = $1', [ids.file]))[0].message_id, ids.message);
  assert.equal((await rows('SELECT is_private FROM channels WHERE id = $1', [ids.teamChannel]))[0].is_private, ids.privateBefore, 'the channel stays as private as it was');
  const members = await rows('SELECT user_id, role, membership_source FROM channel_members WHERE channel_id = $1 ORDER BY user_id', [ids.teamChannel]);
  assert.deepEqual(members.map((m) => [m.user_id, m.role, m.membership_source]), [[ids.lead, 'moderator', 'manual'], [ids.ann, 'member', 'invited']].sort((a, b) => a[0] - b[0]));
  assert.equal((await rows("SELECT COUNT(*)::int AS n FROM channel_members WHERE membership_source = 'team'"))[0].n, 0);
});

test('running the migrations again changes nothing', async (t) => {
  if (skip(t)) return;
  const snapshot = async () => JSON.stringify([await rows('SELECT * FROM channel_members ORDER BY channel_id, user_id'), await rows('SELECT id, name FROM channels ORDER BY id'), await rows('SELECT id FROM messages ORDER BY id')]);
  const before = await snapshot();
  await scratch.applyMigrations(admin);
  await scratch.applyMigrations(admin);
  assert.equal(await snapshot(), before);
});

test('the sidebar still loads for someone whose saved layout names an old team section, without team parts', async (t) => {
  if (skip(t)) return;
  const res = await call(ids.ann, 'GET', '/api/settings/sidebar');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal('teamSections' in res.json.layout, false);
  assert.equal('canCreateTeamSections' in res.json.layout, false);
  assert.ok(Array.isArray(res.json.layout.sections), 'personal sections still work');
  assert.ok((await call(ids.ann, 'PUT', '/api/settings/sidebar', { layout: { sections: [{ id: 's1', name: 'Mine', channelIds: [ids.teamChannel] }] } })).status === 200, 'a former team channel is an ordinary channel and can be placed');
});

test('the team-section routes are gone', async (t) => {
  if (skip(t)) return;
  assert.equal((await call(ids.lead, 'POST', '/api/settings/sidebar/team', { name: 'x' })).status, 404);
  assert.equal((await call(ids.lead, 'PATCH', '/api/settings/sidebar/team/1', { name: 'x' })).status, 404);
  assert.equal((await call(ids.lead, 'DELETE', '/api/settings/sidebar/team/1')).status, 404);
});

test('creating a channel in a team section is refused with a clear error', async (t) => {
  if (skip(t)) return;
  const res = await call(ids.owner, 'POST', '/api/channels', { name: 'tr-new-team', teamSectionId: 1 });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /team/i);
  assert.equal((await rows("SELECT 1 FROM channels WHERE name = 'tr-new-team'")).length, 0);
  assert.equal((await call(ids.owner, 'POST', '/api/channels', { name: 'tr-plain-new' })).status, 201, 'ordinary creation is unaffected');
});

test('changing a manager no longer touches channel membership', async (t) => {
  if (skip(t)) return;
  const before = JSON.stringify(await rows('SELECT * FROM channel_members ORDER BY channel_id, user_id'));
  const res = await call(ids.owner, 'PUT', `/api/people/${ids.ann}/manager`, { managerId: ids.newLead });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(JSON.stringify(await rows('SELECT * FROM channel_members ORDER BY channel_id, user_id')), before);
  assert.equal((await rows('SELECT manager_id FROM users WHERE id = $1', [ids.ann]))[0].manager_id, ids.newLead);
});
