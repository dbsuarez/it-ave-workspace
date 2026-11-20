// GET /api/users/dm-partners: the people you have a direct-message conversation with, the most recent conversation first.
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
  process.env.JWT_SECRET = 'dmp-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const add = async (name) => (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING id", [name, `${name}@x.test`])).rows[0].id;
  for (const name of ['me', 'ann', 'ben', 'cy', 'dee']) ids[name] = await add(`dmp-${name}`);
  const say = (from, to, minutesAgo, text = 'hi') => admin.query(
    "INSERT INTO direct_messages (sender_id, receiver_id, content, created_at) VALUES ($1, $2, $3, NOW() - ($4 || ' minutes')::interval)", [ids[from], ids[to], text, String(minutesAgo)]);
  await say('me', 'ann', 300);
  await say('ann', 'me', 200);        // ann last spoke 200 minutes ago
  await say('ben', 'me', 10);         // ben wrote to me 10 minutes ago
  await say('me', 'cy', 60);          // I wrote to cy 60 minutes ago
  await say('dee', 'ann', 5);         // dee and ann talk: not mine
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

const get = async (who) => {
  const res = await fetch(`${baseUrl}/api/users/dm-partners`, { headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[who], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}` } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('only people you have talked with, whoever wrote last, newest conversation first', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  const { status, json } = await get('me');
  assert.equal(status, 200);
  assert.deepEqual(json.partners.map((p) => p.userId), [ids.ben, ids.cy, ids.ann], 'ben (10 min), cy (60 min), ann (200 min); dee is not a conversation of mine');
  assert.ok(json.partners.every((p) => typeof p.lastAt === 'string' && !Number.isNaN(Date.parse(p.lastAt))));
  assert.equal(json.partners.some((p) => p.userId === ids.me), false, 'never yourself');
});

test('someone with no conversations gets an empty list, and each person only sees their own', async (t) => {
  if (!scratch) return t.skip('no PostgreSQL reachable');
  assert.deepEqual((await get('dee')).json.partners.map((p) => p.userId), [ids.ann]);
  assert.deepEqual((await get('ben')).json.partners.map((p) => p.userId), [ids.me]);
  await admin.query("INSERT INTO users (username, email, password_hash) VALUES ('dmp-new', 'dmp-new@x.test', 'x')");
  ids.new = (await admin.query("SELECT id FROM users WHERE username = 'dmp-new'")).rows[0].id;
  assert.deepEqual((await get('new')).json.partners, []);
});
