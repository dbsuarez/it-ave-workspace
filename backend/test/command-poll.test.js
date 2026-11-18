// /poll: create from a command, vote over HTTP, close, auto-close, anonymous polls. Real PostgreSQL.
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
  process.env.JWT_SECRET = 'command-poll-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const addUser = async (name, type = 'member') => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, `${name}@x.test`, 'x', type])).rows[0].id;
  ids.alice = await addUser('pl-alice');
  ids.bob = await addUser('pl-bob');
  ids.cara = await addUser('pl-cara');
  ids.mod = await addUser('pl-mod');
  ids.outsider = await addUser('pl-outsider');
  ids.guest = await addUser('pl-guest', 'guest');
  ids.banned = await addUser('pl-banned');
  ids.hr = (await admin.query("SELECT id FROM channels WHERE command_scope = 'hr-inquiry'")).rows[0].id;
  for (const user of [ids.alice, ids.bob]) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.hr, user]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = fakeIo; next(); });
  app.use('/api/commands', require('../src/routes/commands'));
  app.use('/api/polls', require('../src/routes/polls'));
  app.use('/api/messages', require('../src/routes/messages'));
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
const run = (userId, channelId, command, requestId) => call(userId, 'POST', '/api/commands/execute', { channelId, command, requestId: requestId || `p${sequence++}` });
const vote = (userId, pollId, optionIds) => call(userId, 'POST', `/api/polls/${pollId}/vote`, { optionIds });
async function channel(extraMembers = []) {
  sequence += 1;
  const id = (await admin.query('INSERT INTO channels (name) VALUES ($1) RETURNING id', [`pl-ch${sequence}`])).rows[0].id;
  for (const user of [ids.alice, ids.bob, ids.cara, ids.mod, ids.guest, ids.banned, ...extraMembers]) {
    await admin.query('INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3)', [id, user, user === ids.mod ? 'moderator' : 'member']);
  }
  return id;
}
// creates a poll through the command and returns its id
async function newPoll(ch, command = '/poll "Lunch?" "Pizza" "Sushi" "Soup"', userId = ids.alice) {
  const result = await run(userId, ch, command);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return (await admin.query('SELECT id FROM polls WHERE channel_id = $1 ORDER BY id DESC LIMIT 1', [ch])).rows[0].id;
}
const options = async (pollId) => (await admin.query('SELECT id, label, position FROM poll_options WHERE poll_id = $1 ORDER BY position', [pollId])).rows;
const votesOf = async (pollId, userId) => (await admin.query('SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2 ORDER BY option_id', [pollId, userId])).rows.map((r) => Number(r.option_id));

test('/poll posts one poll message with its options, and the payload carries a poll without anyone\'s vote', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const before = emitted.length;
  const result = await run(ids.alice, ch, '/poll "Lunch on Friday?" "Pizza" "Sushi and ramen"');
  assert.equal(result.status, 200);
  assert.equal(result.json.title, 'Poll posted');
  const messages = (await admin.query("SELECT id, content, kind FROM messages WHERE channel_id = $1", [ch])).rows;
  assert.equal(messages.length, 1);
  assert.deepEqual([messages[0].content, messages[0].kind], ['Lunch on Friday?', 'poll']);
  const poll = (await admin.query('SELECT * FROM polls WHERE channel_id = $1', [ch])).rows[0];
  assert.equal(poll.message_id, messages[0].id);
  assert.deepEqual([poll.multiple, poll.anonymous, poll.closes_at, poll.closed_at], [false, false, null, null]);
  assert.deepEqual((await options(poll.id)).map((o) => [o.position, o.label]), [[1, 'Pizza'], [2, 'Sushi and ramen']]);
  const event = emitted.slice(before).find((e) => e.room === `channel_${ch}` && e.event === 'new_message');
  assert.equal(event.payload.kind, 'poll');
  assert.equal(event.payload.poll.question, 'Lunch on Friday?');
  assert.deepEqual(event.payload.poll.options.map((o) => [o.label, o.count]), [['Pizza', 0], ['Sushi and ramen', 0]]);
  assert.deepEqual(event.payload.poll.myOptionIds, []);
});

test('flags set multiple choice, anonymity and a closing time', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const id = await newPoll(ch, '/poll "Pick any" "A" "B" --multi --anonymous --closes 2h');
  const row = (await admin.query("SELECT multiple, anonymous, closes_at > NOW() + INTERVAL '119 minutes' AS later, closes_at < NOW() + INTERVAL '121 minutes' AS sooner FROM polls WHERE id = $1", [id])).rows[0];
  assert.deepEqual(row, { multiple: true, anonymous: true, later: true, sooner: true });
});

test('bad polls are refused before anything is posted', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const many = Array.from({ length: 11 }, (_, i) => `"opt${i}"`).join(' ');
  const cases = {
    'no question': '/poll',
    'one option': '/poll "Q?" "only"',
    'eleven options': `/poll "Q?" ${many}`,
    'long question': `/poll "${'q'.repeat(201)}" "a" "b"`,
    'long option': `/poll "Q?" "${'o'.repeat(101)}" "b"`,
    'unknown flag': '/poll "Q?" "a" "b" --secret',
    'closes needs a value': '/poll "Q?" "a" "b" --closes',
    'closes not a duration': '/poll "Q?" "a" "b" --closes soon',
    'closes too far': '/poll "Q?" "a" "b" --closes 31d',
    'unbalanced quote': '/poll "Q? "a" "b',
    'empty option': '/poll "Q?" "a" ""',
  };
  for (const [label, command] of Object.entries(cases)) {
    assert.equal((await run(ids.alice, ch, command)).status, 400, label);
  }
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = $1', [ch])).rows[0].n, 0);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM polls WHERE channel_id = $1', [ch])).rows[0].n, 0);
});

test('guests, archived channels and the HR channel cannot create polls', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  assert.equal((await run(ids.guest, ch, '/poll "Q?" "a" "b"')).status, 403);
  assert.equal((await run(ids.alice, ids.hr, '/poll "Q?" "a" "b"')).status, 404, 'not offered in #hr-inquiry');
  const listedHr = (await call(ids.alice, 'GET', `/api/commands?channelId=${ids.hr}`)).json.commands.map((c) => c.name);
  assert.ok(!listedHr.includes('poll'));
  const listed = (await call(ids.alice, 'GET', `/api/commands?channelId=${ch}`)).json.commands.find((c) => c.name === 'poll');
  assert.equal(listed.category, 'polls');
  await admin.query('UPDATE channels SET archived_at = NOW() WHERE id = $1', [ch]);
  assert.equal((await run(ids.alice, ch, '/poll "Q?" "a" "b"')).status, 409);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM polls WHERE channel_id = $1', [ch])).rows[0].n, 0);
});

test('a retry with the same request id does not post a second poll', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const first = await run(ids.alice, ch, '/poll "Once?" "a" "b"', 'retry-1');
  const second = await run(ids.alice, ch, '/poll "Once?" "a" "b"', 'retry-1');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(second.json.data.message, /already/i);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM polls WHERE channel_id = $1', [ch])).rows[0].n, 1);
});

test('voting replaces your choice in a single-choice poll, even with simultaneous requests', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const poll = await newPoll(ch);
  const [a, b, c] = (await options(poll)).map((o) => Number(o.id));
  assert.equal((await vote(ids.bob, poll, [a])).status, 200);
  assert.deepEqual(await votesOf(poll, ids.bob), [a]);
  assert.equal((await vote(ids.bob, poll, [b])).status, 200);
  assert.deepEqual(await votesOf(poll, ids.bob), [b], 'the second vote replaced the first');
  const results = await Promise.all([a, b, c, a, b, c, a, b].map((option) => vote(ids.cara, poll, [option])));
  assert.ok(results.every((r) => r.status === 200 || r.status === 409), 'no request errors out');
  assert.equal((await votesOf(poll, ids.cara)).length, 1, 'exactly one vote survives');
  const view = (await call(ids.bob, 'GET', `/api/polls/${poll}`)).json;
  assert.equal(view.options.reduce((sum, o) => sum + o.count, 0), 2, 'Bob and Cara have one vote each');
  assert.deepEqual(view.myOptionIds, [b]);
});

test('multiple-choice polls take several options; invalid selections are refused', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const multi = await newPoll(ch, '/poll "Pick" "A" "B" "C" --multi');
  const [a, b, c] = (await options(multi)).map((o) => Number(o.id));
  assert.equal((await vote(ids.bob, multi, [a, c])).status, 200);
  assert.deepEqual(await votesOf(multi, ids.bob), [a, c].sort((x, y) => x - y));
  assert.equal((await vote(ids.bob, multi, [])).status, 400, 'a vote needs at least one option');
  assert.equal((await vote(ids.bob, multi, [a, a])).status, 400, 'duplicates');
  assert.equal((await vote(ids.bob, multi, ['x'])).status, 400, 'not an id');
  const other = await newPoll(ch);
  const foreign = Number((await options(other))[0].id);
  assert.equal((await vote(ids.bob, multi, [foreign])).status, 400, 'an option from another poll');
  const single = await newPoll(ch);
  const [s1, s2] = (await options(single)).map((o) => Number(o.id));
  assert.equal((await vote(ids.bob, single, [s1, s2])).status, 400, 'single choice takes exactly one');
  assert.equal((await call(ids.bob, 'DELETE', `/api/polls/${multi}/vote`)).status, 200);
  assert.deepEqual(await votesOf(multi, ids.bob), [], 'withdrawn');
});

test('voting is refused when closed, archived, for non-members, guests and banned people', async (t) => {
  if (skip(t)) return;
  const ch = await channel([ids.outsider]);
  await admin.query('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [ch, ids.outsider]);
  const poll = await newPoll(ch);
  const [a] = (await options(poll)).map((o) => Number(o.id));
  assert.equal((await vote(ids.outsider, poll, [a])).status, 403, 'not a member');
  assert.equal((await vote(ids.guest, poll, [a])).status, 403, 'guest');
  await admin.query("INSERT INTO channel_bans (channel_id, user_id, reason) VALUES ($1, $2, 'test')", [ch, ids.banned]);
  assert.equal((await vote(ids.banned, poll, [a])).status, 403, 'banned');
  await admin.query('UPDATE channels SET archived_at = NOW() WHERE id = $1', [ch]);
  assert.equal((await vote(ids.bob, poll, [a])).status, 409, 'archived channel');
  assert.equal((await call(ids.bob, 'DELETE', `/api/polls/${poll}/vote`)).status, 409, 'withdrawing is a write too');
  assert.equal((await call(ids.bob, 'GET', `/api/polls/${poll}`)).status, 200, 'reading still works');
  await admin.query('UPDATE channels SET archived_at = NULL WHERE id = $1', [ch]);
  await admin.query('UPDATE polls SET closed_at = NOW() WHERE id = $1', [poll]);
  assert.equal((await vote(ids.bob, poll, [a])).status, 409, 'closed poll');
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM poll_votes WHERE poll_id = $1', [poll])).rows[0].n, 0);
});

test('the creator or a channel moderator closes a poll; nobody else can', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const poll = await newPoll(ch);
  const [a] = (await options(poll)).map((o) => Number(o.id));
  assert.equal((await call(ids.bob, 'POST', `/api/polls/${poll}/close`)).status, 403, 'an ordinary member');
  assert.equal((await call(ids.mod, 'POST', `/api/polls/${poll}/close`)).status, 200, 'a channel moderator');
  assert.equal((await call(ids.mod, 'POST', `/api/polls/${poll}/close`)).status, 200, 'closing twice is fine');
  assert.equal((await vote(ids.bob, poll, [a])).status, 409);
  assert.equal((await call(ids.bob, 'GET', `/api/polls/${poll}`)).json.closed, true);
  const mine = await newPoll(ch);
  assert.equal((await call(ids.alice, 'POST', `/api/polls/${mine}/close`)).status, 200, 'the creator');
});

test('a poll with a closing time closes itself the next time it is read or voted on', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const poll = await newPoll(ch, '/poll "Quick?" "a" "b" --closes 1m');
  const [a] = (await options(poll)).map((o) => Number(o.id));
  assert.equal((await vote(ids.bob, poll, [a])).status, 200, 'open before the time');
  await admin.query("UPDATE polls SET closes_at = NOW() - INTERVAL '1 second' WHERE id = $1", [poll]);
  assert.equal((await call(ids.bob, 'GET', `/api/polls/${poll}`)).json.closed, true);
  assert.equal((await vote(ids.cara, poll, [a])).status, 409);
  assert.equal((await admin.query('SELECT closed_at IS NOT NULL AS closed FROM polls WHERE id = $1', [poll])).rows[0].closed, true);
});

test('named polls show voters to members; anonymous polls never reveal who voted anywhere', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const named = await newPoll(ch);
  const [n1] = (await options(named)).map((o) => Number(o.id));
  await vote(ids.bob, named, [n1]);
  const view = (await call(ids.cara, 'GET', `/api/polls/${named}`)).json;
  assert.deepEqual(view.options[0].voters, ['pl-bob']);

  const anon = await newPoll(ch, '/poll "Secret?" "yes" "no" --anonymous');
  const [y] = (await options(anon)).map((o) => Number(o.id));
  const cast = await vote(ids.bob, anon, [y]);
  const outputs = [
    JSON.stringify(cast.json),
    JSON.stringify((await call(ids.cara, 'GET', `/api/polls/${anon}`)).json),
    JSON.stringify((await call(ids.cara, 'GET', `/api/messages/${ch}`)).json.messages.find((m) => m.poll && m.poll.id === Number(anon))),
    // every event this anonymous poll caused: its creation message and its change notifications
    JSON.stringify(emitted.filter((e) => (e.event === 'poll_updated' && e.payload.pollId === Number(anon))
      || (e.event === 'new_message' && e.payload.poll && e.payload.poll.id === Number(anon)))),
  ];
  assert.ok(JSON.parse(outputs[3]).length >= 2, 'the poll\'s creation and change events were captured, so the checks below are not vacuous');
  for (const output of outputs) {
    assert.doesNotMatch(output, /pl-bob/, 'no username');
    assert.doesNotMatch(output, /"voters"/, 'no voter list at all');
  }
  assert.equal(JSON.parse(outputs[1]).options[0].count, 1, 'but the counts are there');
  assert.deepEqual(JSON.parse(outputs[0]).myOptionIds, [y], 'and you still see your own vote');
});

test('history carries each poll with the viewer\'s own votes, and a vote tells the channel only which poll changed', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const poll = await newPoll(ch);
  const [a] = (await options(poll)).map((o) => Number(o.id));
  const before = emitted.length;
  await vote(ids.bob, poll, [a]);
  const update = emitted.slice(before).find((e) => e.event === 'poll_updated');
  assert.equal(update.room, `channel_${ch}`);
  assert.deepEqual(Object.keys(update.payload).sort(), ['channelId', 'pollId']);
  const forBob = (await call(ids.bob, 'GET', `/api/messages/${ch}`)).json.messages.find((m) => m.kind === 'poll');
  const forCara = (await call(ids.cara, 'GET', `/api/messages/${ch}`)).json.messages.find((m) => m.kind === 'poll');
  assert.deepEqual(forBob.poll.myOptionIds, [a]);
  assert.deepEqual(forCara.poll.myOptionIds, []);
});

test('markup in a question or option is stored verbatim for the client to escape', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const poll = await newPoll(ch, '/poll "<script>alert(1)</script> & co?" "<b>x</b>" "a & b"');
  const row = (await admin.query('SELECT question FROM polls WHERE id = $1', [poll])).rows[0];
  assert.equal(row.question, '<script>alert(1)</script> & co?');
  assert.deepEqual((await options(poll)).map((o) => o.label), ['<b>x</b>', 'a & b']);
});

// a new member of the channel, so the per-user command rate limit (30 a minute) never mixes tests up
async function freshMember(ch) {
  sequence += 1;
  const id = (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING id", [`pl-f${sequence}`, `pl-f${sequence}@x.test`])).rows[0].id;
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ch, id]);
  return id;
}

test('simultaneous requests with the same request id create exactly one poll', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const creator = await freshMember(ch);
  const results = await Promise.all(Array.from({ length: 6 }, () => run(creator, ch, '/poll "Race?" "a" "b"', 'race-1')));
  assert.ok(results.every((r) => r.status === 200), 'every request is answered');
  assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM polls WHERE channel_id = $1 AND question = 'Race?'", [ch])).rows[0].n, 1);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = $1', [ch])).rows[0].n, 1);
  assert.equal(results.filter((r) => r.json.title === 'Poll posted').length, 1, 'only one of them did the work');
});

test('loading many polls takes a fixed, small number of queries and gives the same answer as loading them one by one', async (t) => {
  if (skip(t)) return;
  const polls = require('../src/polls');
  const { query } = require('../src/db');
  const ch = await channel();
  const creator = await freshMember(ch);
  const created = [];
  for (let i = 0; i < 12; i += 1) created.push(await newPoll(ch, `/poll "Question ${i}?" "yes" "no" ${i % 2 ? '--anonymous' : ''}`, creator));
  for (const [i, id] of created.entries()) {
    const [first] = (await options(id)).map((o) => Number(o.id));
    if (i % 3 === 0) await vote(ids.bob, id, [first]);
    if (i % 4 === 0) await vote(await freshMember(ch), id, [first]);
  }
  await admin.query("UPDATE polls SET closes_at = NOW() - INTERVAL '1 second' WHERE id = $1", [created[5]]);
  const messageIds = (await admin.query('SELECT message_id FROM polls WHERE channel_id = $1 ORDER BY id', [ch])).rows.map((r) => r.message_id);
  let calls = 0;
  const counting = (...args) => { calls += 1; return query(...args); };
  const batch = await polls.pollsForMessages(counting, messageIds, ids.bob);
  assert.ok(calls <= 8, `12 polls should not cost ${calls} queries`);
  assert.equal(batch.size, 12);
  for (const id of created) {
    const single = await polls.serializePoll(query, id, ids.bob);
    assert.deepEqual(batch.get(single.messageId), single, `poll ${id} is the same either way`);
  }
  assert.equal(batch.get((await polls.serializePoll(query, created[5], ids.bob)).messageId).closed, true, 'an expired poll is shown closed');
});

test('the pinned list says what a pinned poll or announcement is', async (t) => {
  if (skip(t)) return;
  const ch = await channel();
  const creator = await freshMember(ch);
  await newPoll(ch, '/poll "Lunch?" "Pizza" "Sushi" "Soup"', creator);
  await admin.query("INSERT INTO messages (channel_id, user_id, content, kind) VALUES ($1, $2, 'All hands at 3', 'announcement'), ($1, $2, 'plain one', 'message')", [ch, creator]);
  await admin.query('UPDATE messages SET pinned_at = NOW(), pinned_by = $2 WHERE channel_id = $1', [ch, ids.mod]);
  const pins = (await call(ids.bob, 'GET', `/api/messages/${ch}/pins`)).json.messages;
  assert.deepEqual(pins.map((m) => [m.content, m.kind]).sort(), [['All hands at 3', 'announcement'], ['Lunch?', 'poll'], ['plain one', 'message']]);
});
