// /help and /search: global, private commands. /search must show exactly what the Search box would.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config;
const ids = {};
let sequence = 0;

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'command-help-search-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const addUser = async (name, type = 'member', superadmin = false) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, `${name}@x.test`, 'x', type, superadmin])).rows[0].id;
  ids.owner = await addUser('hs-owner', 'member', true);
  ids.bob = await addUser('hs-bob');
  ids.needleman = await addUser('needleman');
  ids.general = (await admin.query("INSERT INTO channels (name, is_private) VALUES ('hs-general', FALSE) RETURNING id")).rows[0].id;
  ids.secret = (await admin.query("INSERT INTO channels (name, is_private) VALUES ('hs-secret', TRUE) RETURNING id")).rows[0].id;
  ids.hr = (await admin.query("SELECT id FROM channels WHERE command_scope = 'hr-inquiry'")).rows[0].id;
  for (const user of [ids.owner, ids.bob]) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($3, $2)', [ids.general, user, ids.hr]);
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.secret, ids.bob]);
  await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'needle in the open')", [ids.general, ids.bob]);
  await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'needle in the secret room')", [ids.secret, ids.bob]);
  for (let i = 0; i < 7; i += 1) await admin.query("INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, $3)", [ids.general, ids.bob, `bulk row ${i}`]);
  const app = express();
  app.use(express.json());
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
async function member(channels) {
  sequence += 1;
  const id = (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING id", [`hs-m${sequence}`, `hs-m${sequence}@x.test`])).rows[0].id;
  for (const channel of channels) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channel, id]);
  return id;
}
async function run(userId, channelId, command) {
  const response = await fetch(`${baseUrl}/api/commands/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, command, requestId: `r${sequence++}` }),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const rows = (response) => response.json.data.table.rows;
const messageCount = async () => (await admin.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n;

test('/help lists what is available in this channel, grouped, without HR commands outside the HR channel', async (t) => {
  if (skip(t)) return;
  const user = await member([ids.general, ids.hr]);
  const plain = await run(user, ids.general, '/help');
  assert.equal(plain.status, 200);
  assert.equal(plain.json.kind, 'command-help');
  assert.deepEqual(plain.json.data.table.head, ['Command', 'What it does', 'Category']);
  const names = rows(plain).map((row) => row[0]);
  assert.ok(names.includes('/help [command]') && names.includes('/search <keywords>'));
  assert.ok(!names.some((name) => name.startsWith('/leave')), 'HR commands are not offered outside #hr-inquiry');
  const inHr = rows(await run(user, ids.hr, '/help')).map((row) => row[0]);
  assert.ok(inHr.includes('/leave') && inHr.includes('/search <keywords>'), 'in #hr-inquiry both groups appear');
});

test('/help <command> explains one command, and never reveals one that is not available here', async (t) => {
  if (skip(t)) return;
  const user = await member([ids.general, ids.hr]);
  const one = await run(user, ids.general, '/help search');
  assert.equal(one.status, 200);
  assert.deepEqual(rows(one), [['/search <keywords>', 'Search messages, people and files you can see']]);
  const hr = await run(user, ids.hr, '/help leave-remaining');
  assert.equal(rows(hr)[0][0], '/leave-remaining');
  const unavailable = await run(user, ids.general, '/help leave-remaining');
  assert.equal(unavailable.status, 200);
  assert.match(unavailable.json.data.message, /No command named \/leave-remaining here/);
  assert.match((await run(user, ids.general, '/help nope')).json.data.message, /No command named \/nope here/);
});

test('/search shows only what the person can see, at most 5 per kind, with an action to open the full search', async (t) => {
  if (skip(t)) return;
  const user = await member([ids.general]);
  const result = await run(user, ids.general, '/search needle');
  assert.equal(result.status, 200);
  const text = JSON.stringify(rows(result));
  assert.match(text, /needle in the open/);
  assert.doesNotMatch(text, /secret room/, 'a private channel the person is not in never appears');
  assert.ok(rows(result).some((row) => row[0] === 'Person' && row[1] === 'needleman'));
  assert.deepEqual(result.json.actions, [{ type: 'open-route', route: 'search', query: 'needle' }]);
  const bulk = await run(user, ids.general, '/search bulk row');
  assert.equal(rows(bulk).filter((row) => row[0] === 'Message').length, 5, 'capped at 5 messages');
  assert.deepEqual((await run(user, ids.general, '/search "bulk row 3"')).json.actions[0].query, 'bulk row 3', 'quoted keywords work');
});

test('/search with nothing found says so, and an Owner outside a private channel sees nothing of it until the switch is on', async (t) => {
  if (skip(t)) return;
  const user = await member([ids.general]);
  const none = await run(user, ids.general, '/search zzzzqq');
  assert.equal(none.status, 200);
  assert.match(none.json.data.message, /Nothing found/);
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = FALSE WHERE id = 1');
  assert.doesNotMatch(JSON.stringify(rows(await run(ids.owner, ids.general, '/search needle'))), /secret room/, 'switch off: the Owner is a normal member here');
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = TRUE WHERE id = 1');
  assert.match(JSON.stringify(rows(await run(ids.owner, ids.general, '/search needle'))), /secret room/, 'switch on: same visibility as the Search box');
  await admin.query('UPDATE moderation_settings SET owner_private_channel_access = FALSE WHERE id = 1');
});

test('/search refuses a query that is too short or too long, and neither command posts anything', async (t) => {
  if (skip(t)) return;
  const user = await member([ids.general]);
  const before = await messageCount();
  assert.equal((await run(user, ids.general, '/search a')).status, 400);
  assert.equal((await run(user, ids.general, '/search')).status, 400);
  assert.equal((await run(user, ids.general, `/search ${'x'.repeat(101)}`)).status, 400);
  await run(user, ids.general, '/help');
  await run(user, ids.general, '/search needle');
  assert.equal(await messageCount(), before, 'private commands create no messages');
});

test('/search treats SQL wildcards as plain text', async (t) => {
  if (skip(t)) return;
  const user = await member([ids.general]);
  const wildcard = await run(user, ids.general, '/search %%');
  assert.equal(wildcard.status, 200);
  assert.match(wildcard.json.data.message, /Nothing found/, '"%%" matches nothing instead of everything');
});
