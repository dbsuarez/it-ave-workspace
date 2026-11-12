// Leave: types, balances, requests, approval, calendar and holidays, against a real PostgreSQL (scratch database).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch;
let admin;
let server;
let baseUrl;
let pool;
let config;
const ids = {};
const emitted = [];

const DAY = 24 * 60 * 60 * 1000;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
// A Monday this many weeks from now (UTC), so the tests never depend on today's date
function monday(weeksAhead) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return addDays(d, ((8 - d.getUTCDay()) % 7 || 7) + 7 * weeksAhead);
}

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'leave-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name, { type = 'member', superadmin = false, hr = false, manager = null } = {}) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type, is_superadmin, is_hr, manager_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [name, `${name}@x.test`, 'x', type, superadmin, hr, manager]
  )).rows[0].id;
  ids.boss = await user('boss', { superadmin: true });
  ids.hr = await user('hana', { hr: true });
  ids.lead = await user('lead');
  ids.ann = await user('ann', { manager: ids.lead });
  ids.bob = await user('bob', { manager: ids.lead });
  ids.cy = await user('cy');
  ids.guest = await user('visitor', { type: 'guest' });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
    next();
  });
  app.use('/api/leave', require('../src/routes/leave'));
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

const call = async (userId, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/leave${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const typeId = async (name) => (await admin.query('SELECT id FROM leave_types WHERE name = $1', [name])).rows[0].id;

test('the standard leave types exist, members read them, only HR changes them', async (t) => {
  if (skip(t)) return;
  const list = await call(ids.ann, 'GET', '/types');
  assert.deepEqual(list.json.types.map((x) => x.name), ['Vacation Leave', 'Sick Leave', 'Emergency Leave', 'Unpaid Leave']);
  assert.equal((await call(ids.guest, 'GET', '/types')).status, 403);
  assert.equal((await call(ids.ann, 'POST', '/types', { name: 'Study Leave', daysPerYear: 5 })).status, 403);
  const made = await call(ids.hr, 'POST', '/types', { name: 'Study Leave', daysPerYear: 5, paid: true });
  assert.equal(made.status, 201);
  assert.equal((await call(ids.hr, 'POST', '/types', { name: 'study leave', daysPerYear: 1 })).status, 409);
  assert.equal((await call(ids.hr, 'POST', '/types', { name: 'X', daysPerYear: 1.3 })).status, 400, 'in halves');
  assert.equal((await call(ids.hr, 'PUT', `/types/${made.json.type.id}`, { daysPerYear: 6 })).json.type.daysPerYear, 6);
  assert.equal((await call(ids.hr, 'DELETE', `/types/${made.json.type.id}`)).json.hidden, false, 'unused: removed');
  assert.equal((await call(ids.hr, 'DELETE', `/types/${made.json.type.id}`)).status, 404);
});

test('a request counts working days, skips holidays, and is checked against the balance', async (t) => {
  if (skip(t)) return;
  const vacation = await typeId('Vacation Leave');
  const mon = monday(2);
  const holiday = addDays(mon, 2); // the Wednesday
  assert.equal((await call(ids.ann, 'POST', '/holidays', { day: iso(holiday), name: 'Founders Day' })).status, 403);
  assert.equal((await call(ids.hr, 'POST', '/holidays', { day: iso(holiday), name: 'Founders Day' })).status, 201);

  const req = await call(ids.ann, 'POST', '/requests', { typeId: vacation, startDate: iso(mon), endDate: iso(addDays(mon, 6)), reason: 'Trip' });
  assert.equal(req.status, 201);
  assert.equal(req.json.request.days, 4, 'Mon, Tue, Thu, Fri: the Wednesday holiday and the weekend are not counted');
  assert.equal(req.json.request.status, 'pending');
  const told = emitted.filter((e) => e.event === 'leave_updated' && e.payload.kind === 'requested').map((e) => e.room).sort();
  assert.deepEqual(told, [`user_${ids.boss}`, `user_${ids.hr}`, `user_${ids.lead}`].sort(), 'the manager, HR and the Superadmin are told');

  const me = (await call(ids.ann, 'GET', `/me?year=${mon.getUTCFullYear()}`)).json;
  const bal = me.balances.find((b) => b.name === 'Vacation Leave');
  assert.deepEqual([bal.entitled, bal.used, bal.pending, bal.remaining], [15, 0, 4, 11]);
  assert.equal(me.requests.length, 1);

  const bad = (body) => call(ids.ann, 'POST', '/requests', { typeId: vacation, ...body });
  assert.equal((await bad({ startDate: iso(addDays(mon, 1)), endDate: iso(addDays(mon, 1)) })).status, 409, 'overlaps the first request');
  assert.equal((await bad({ startDate: iso(addDays(mon, 12)), endDate: iso(addDays(mon, 13)) })).status, 400, 'a weekend has no working days');
  assert.equal((await bad({ startDate: iso(addDays(mon, 21)), endDate: iso(addDays(mon, 20)) })).status, 400, 'end before start');
  assert.equal((await bad({ startDate: '2026-02-30' })).status, 400);
  assert.equal((await bad({ startDate: iso(addDays(mon, 21)), endDate: iso(addDays(mon, 22)), halfDay: true })).status, 400, 'a half day is one day');
  assert.equal((await bad({ startDate: iso(addDays(mon, 21)), endDate: iso(addDays(mon, 130)) })).status, 400, 'too long');
  assert.equal((await bad({ startDate: '2019-01-07', endDate: '2019-01-07' })).status, 400, 'too long ago');
  assert.equal((await call(ids.ann, 'POST', '/requests', { typeId: 99999, startDate: iso(mon) })).status, 404);
  assert.equal((await call(ids.guest, 'POST', '/requests', { typeId: vacation, startDate: iso(mon) })).status, 403);

  const half = await bad({ startDate: iso(addDays(mon, 21)), endDate: iso(addDays(mon, 21)), halfDay: true });
  assert.equal(half.json.request.days, 0.5);
  const tooMuch = await bad({ startDate: iso(addDays(mon, 28)), endDate: iso(addDays(mon, 46)) }); // 15 working days, only 10.5 left
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.json.error, /Not enough Vacation Leave/);
  const unpaid = await typeId('Unpaid Leave');
  assert.equal((await call(ids.ann, 'POST', '/requests', { typeId: unpaid, startDate: iso(addDays(mon, 28)), endDate: iso(addDays(mon, 46)) })).status, 201, 'unpaid leave has no cap');
});

test('the manager or HR decides; nobody decides their own; a decision is final; rejecting frees the days', async (t) => {
  if (skip(t)) return;
  const sick = await typeId('Sick Leave');
  const mon = monday(10);
  const asked = await call(ids.bob, 'POST', '/requests', { typeId: sick, startDate: iso(mon), endDate: iso(addDays(mon, 1)), reason: 'Flu' });
  const id = asked.json.request.id;

  const waiting = await call(ids.lead, 'GET', '/approvals');
  assert.ok(waiting.json.requests.some((r) => r.id === id), 'it waits for their manager');
  assert.equal((await call(ids.cy, 'GET', '/approvals')).json.requests.length, 0, 'someone else sees nothing');
  assert.ok((await call(ids.hr, 'GET', '/approvals')).json.requests.some((r) => r.id === id), 'HR sees everything pending');
  assert.equal((await call(ids.bob, 'PUT', `/requests/${id}/decision`, { status: 'approved' })).status, 403, 'not their own');
  assert.equal((await call(ids.cy, 'PUT', `/requests/${id}/decision`, { status: 'approved' })).status, 403, 'not just anyone');
  assert.equal((await call(ids.lead, 'PUT', `/requests/${id}/decision`, { status: 'maybe' })).status, 400);

  emitted.length = 0;
  const rejected = await call(ids.lead, 'PUT', `/requests/${id}/decision`, { status: 'rejected', note: 'Release week' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.request.status, 'rejected');
  assert.equal(rejected.json.request.decisionNote, 'Release week');
  assert.equal(rejected.json.request.decidedBy, 'lead');
  assert.ok(emitted.some((e) => e.room === `user_${ids.bob}` && e.payload.kind === 'rejected'), 'the requester is told');
  assert.equal((await call(ids.hr, 'PUT', `/requests/${id}/decision`, { status: 'approved' })).status, 409, 'already decided');
  const bal = (await call(ids.bob, 'GET', `/me?year=${mon.getUTCFullYear()}`)).json.balances.find((b) => b.name === 'Sick Leave');
  assert.equal(bal.remaining, 10, 'a rejected request uses nothing');

  const again = await call(ids.bob, 'POST', '/requests', { typeId: sick, startDate: iso(mon), endDate: iso(addDays(mon, 1)) });
  assert.equal(again.status, 201, 'the same days can be asked again');
  assert.equal((await call(ids.hr, 'PUT', `/requests/${again.json.request.id}/decision`, { status: 'approved' })).json.request.status, 'approved', 'HR may approve');
  const after = (await call(ids.bob, 'GET', `/me?year=${mon.getUTCFullYear()}`)).json.balances.find((b) => b.name === 'Sick Leave');
  assert.deepEqual([after.used, after.pending, after.remaining], [2, 0, 8]);

  const cancel = await call(ids.bob, 'POST', `/requests/${again.json.request.id}/cancel`);
  assert.equal(cancel.json.request.status, 'cancelled', 'approved leave that has not happened yet can be cancelled');
  assert.equal((await call(ids.bob, 'POST', `/requests/${again.json.request.id}/cancel`)).status, 400);
  assert.equal((await call(ids.cy, 'POST', `/requests/${id}/cancel`)).status, 404, 'only the owner');
});

test('the calendar shows the team, and HR can see everyone', async (t) => {
  if (skip(t)) return;
  const vacation = await typeId('Vacation Leave');
  const mon = monday(6);
  await call(ids.ann, 'POST', '/requests', { typeId: vacation, startDate: iso(mon), endDate: iso(mon) });
  await call(ids.cy, 'POST', '/requests', { typeId: vacation, startDate: iso(addDays(mon, 1)), endDate: iso(addDays(mon, 1)) });
  const month = iso(mon).slice(0, 7);
  const team = (await call(ids.bob, 'GET', `/calendar?month=${month}`)).json;
  const names = team.requests.map((r) => r.username);
  assert.ok(names.includes('ann'), 'bob shares a manager with ann');
  assert.ok(!names.includes('cy'), 'cy is not on bob\'s team');
  assert.equal(team.scope, 'team');
  assert.ok((await call(ids.bob, 'GET', `/calendar?month=${month}&scope=all`)).json.requests.every((r) => r.username !== 'cy'), 'an ordinary member cannot ask for everyone');
  const all = (await call(ids.hr, 'GET', `/calendar?month=${month}&scope=all`)).json;
  assert.ok(all.requests.some((r) => r.username === 'cy') && all.scope === 'all');
  assert.equal((await call(ids.bob, 'GET', '/calendar?month=nope')).status, 200, 'a bad month falls back to this month');
});

test('HR adjusts a balance and keeps the holiday list', async (t) => {
  if (skip(t)) return;
  const vacation = await typeId('Vacation Leave');
  const year = monday(0).getUTCFullYear();
  assert.equal((await call(ids.ann, 'PUT', '/entitlements', { userId: ids.cy, typeId: vacation, year, adjustment: 5 })).status, 403);
  assert.equal((await call(ids.hr, 'PUT', '/entitlements', { userId: ids.cy, typeId: vacation, year, adjustment: 1.3 })).status, 400);
  const set = await call(ids.hr, 'PUT', '/entitlements', { userId: ids.cy, typeId: vacation, year, adjustment: 5 });
  assert.equal(set.json.balances.find((b) => b.name === 'Vacation Leave').entitled, 20);
  const seen = await call(ids.hr, 'GET', `/balances/${ids.cy}?year=${year}`);
  assert.equal(seen.json.balances.find((b) => b.name === 'Vacation Leave').adjustment, 5);
  assert.equal((await call(ids.ann, 'GET', `/balances/${ids.cy}`)).status, 403);

  const day = iso(monday(30));
  await call(ids.hr, 'POST', '/holidays', { day, name: 'First name' });
  await call(ids.hr, 'POST', '/holidays', { day, name: 'Renamed' });
  const list = (await call(ids.ann, 'GET', `/holidays?year=${day.slice(0, 4)}`)).json.holidays;
  assert.deepEqual(list.filter((h) => h.day === day).map((h) => h.name), ['Renamed'], 'a date has one name');
  assert.equal((await call(ids.hr, 'DELETE', `/holidays/${day}`)).status, 200);
  assert.equal((await call(ids.hr, 'DELETE', `/holidays/${day}`)).status, 404);
  assert.equal((await call(ids.hr, 'POST', '/holidays', { day: 'x', name: 'n' })).status, 400);
});

test('a leave type that has requests is hidden, not deleted', async (t) => {
  if (skip(t)) return;
  const emergency = await typeId('Emergency Leave');
  const mon = monday(15);
  await call(ids.ann, 'POST', '/requests', { typeId: emergency, startDate: iso(mon), endDate: iso(mon) });
  assert.equal((await call(ids.hr, 'DELETE', `/types/${emergency}`)).json.hidden, true);
  assert.ok(!(await call(ids.ann, 'GET', '/types')).json.types.some((x) => x.id === emergency), 'members no longer see it');
  assert.ok((await call(ids.hr, 'GET', '/types')).json.types.some((x) => x.id === emergency), 'HR still does');
  assert.equal((await call(ids.ann, 'POST', '/requests', { typeId: emergency, startDate: iso(addDays(mon, 7)) })).status, 404, 'and it cannot be requested');
});
