// GET /api/users/:id/card: what the small profile card shows about a person (and what it never shows).
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
  process.env.JWT_SECRET = 'card-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const add = async (name, fields = {}) => (await admin.query(
    `INSERT INTO users (username, email, password_hash, account_type, is_superadmin, first_name, last_name, job_title, department, location, status, status_text, profile, manager_id)
     VALUES ($1, $2, 'x', $3, $4, $5, $6, $7, $8, $9, 'online', $10, $11, $12) RETURNING id`,
    [name, `${name}@x.test`, fields.type || 'member', Boolean(fields.owner), fields.first || '', fields.last || '', fields.title || '', fields.dept || '', fields.loc || '', fields.statusText || '', fields.profile || {}, fields.manager || null])).rows[0].id;
  ids.boss = await add('card-boss', { first: 'Bea', last: 'Cruz', title: 'Head of MIS' });
  ids.dante = await add('card-dante', { first: 'Dante', last: 'Suarez', title: 'Developer', dept: 'MIS', loc: 'Makati', statusText: 'In a meeting', manager: ids.boss, profile: { hide: { location: false } } });
  ids.shy = await add('card-shy', { first: 'Sy', last: 'Hide', title: 'Analyst', loc: 'Cebu', profile: { hide: { location: true, email: true } } });
  ids.viewer = await add('card-viewer', { first: 'Vic', last: 'Viewer' });
  ids.guest = await add('card-guest', { type: 'guest' });
  ids.root = await add('admin', { owner: true });
  const channel = async (name, members) => {
    const c = (await admin.query('INSERT INTO channels (name, created_by) VALUES ($1, $2) RETURNING id', [name, ids.boss])).rows[0].id;
    for (const m of members) await admin.query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'member')", [c, m]);
    return c;
  };
  await channel('card-a', [ids.viewer, ids.dante]);
  await channel('card-b', [ids.viewer, ids.dante, ids.shy]);
  await channel('card-c', [ids.viewer]);
  await channel('card-guest-room', [ids.guest, ids.shy]);
  const app = express();
  app.use('/api/users', require('../src/routes/users'));
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

const get = async (viewer, id) => {
  const res = await fetch(`${baseUrl}/api/users/${id}/card`, { headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[viewer], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}` } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('the card has the person\'s name, title, department, location, manager, status and how many channels you share', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const { status, json } = await get('viewer', ids.dante);
  assert.equal(status, 200);
  const card = json.card;
  assert.equal(card.id, ids.dante);
  assert.equal(card.username, 'card-dante');
  assert.equal(card.firstName, 'Dante');
  assert.equal(card.lastName, 'Suarez');
  assert.equal(card.jobTitle, 'Developer');
  assert.equal(card.department, 'MIS');
  assert.equal(card.location, 'Makati');
  assert.equal(card.managerName, 'Bea Cruz', 'the manager is named in full');
  assert.equal(card.statusText, 'In a meeting');
  assert.equal(card.status, 'online');
  assert.equal(card.sharedChannels, 2, 'two channels have both of them');
});

test('the card never carries an email, a phone number or role names, and a hidden location stays hidden', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const { json } = await get('viewer', ids.shy);
  const card = json.card;
  assert.equal(card.location, '', 'the person chose to hide it');
  const text = JSON.stringify(json);
  assert.equal(/@x\.test|phone|roles|password|is_superadmin|isSuperadmin/i.test(text), false, text);
  const own = (await get('shy', ids.shy)).json.card;
  assert.equal(own.location, 'Cebu', 'you see your own');
  assert.equal(own.sharedChannels, null, 'a shared-channel count with yourself means nothing');
});

test('the built-in admin account, deactivated people and unknown people have no card', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  assert.equal((await get('viewer', ids.root)).status, 404);
  assert.equal((await get('viewer', 999999)).status, 404);
  assert.equal((await get('viewer', 'abc')).status, 400);
  await admin.query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [ids.shy]);
  assert.equal((await get('viewer', ids.shy)).status, 404);
  await admin.query('UPDATE users SET deactivated_at = NULL WHERE id = $1', [ids.shy]);
});

test('a guest only sees the cards of people they share a channel with', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  assert.equal((await get('guest', ids.shy)).status, 200);
  assert.equal((await get('guest', ids.dante)).status, 404);
});
