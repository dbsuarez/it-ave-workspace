// Sheets that feed Leave: declaring what a table feeds, the preview-then-confirm Publish, and Leave's read-only years, against a real PostgreSQL.
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
  process.env.JWT_SECRET = 'feeds-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const add = async (name) => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', 'member'])).rows[0].id;
  for (const name of ['hr', 'ed', 'ann', 'bob', 'cy']) ids[name] = await add(`fd-${name}`);
  await admin.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE legacy_hr = true', [ids.hr]);
  const app = express();
  app.use('/api/sheets', require('../src/routes/sheets'));
  app.use(express.json());
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

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const request = async (user, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[user], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const sheetsApi = (user, method, path, body) => request(user, method, `/api/sheets${path}`, body);
const leaveApi = (user, method, path, body) => request(user, method, `/api/leave${path}`, body);

const holidayColumns = [{ name: 'date', type: 'date', required: true }, { name: 'name', type: 'text', required: true }];
const creditColumns = [{ name: 'person', type: 'person', required: true }, { name: 'leave_type', type: 'text', required: true },
  { name: 'year', type: 'number', required: true }, { name: 'days', type: 'number', required: true }];
const holidayRows = [['date', 'name'], ['2027-01-01', 'New Year Day'], ['2027-12-25', 'Christmas']];

async function makeSheet(title, tabName, rows, tabId) {
  const made = await sheetsApi('hr', 'POST', '', { title, data: { tabs: [{ id: tabId, name: tabName, rows }] } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  return made.json.sheet.id;
}
const holidaysOf = async (year) => (await admin.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM company_holidays WHERE EXTRACT(YEAR FROM day) = $1 ORDER BY day", [year])).rows;

test('a table can be declared as feeding holidays: the columns must fit, only Manage sheets people may, and one table feeds at a time', async (t) => {
  if (skip(t)) return;
  ids.sheetA = await makeSheet('Holidays 2027', 'Holidays', holidayRows, 'tabH');
  ids.sheetB = await makeSheet('Other holidays', 'Days', holidayRows, 'tabD');
  const put = (user, sheet, tabId, body) => sheetsApi(user, 'PUT', `/${sheet}/tables/holidays`, { tabId, ...body });
  assert.equal((await put('hr', ids.sheetA, 'tabH', { columns: [{ name: 'date', type: 'date' }], feeds: 'holidays' })).status, 400, 'a name column is needed');
  assert.equal((await put('hr', ids.sheetA, 'tabH', { columns: holidayColumns, feeds: 'rain' })).status, 400, 'an unknown kind of feed');
  await sheetsApi('hr', 'PUT', `/${ids.sheetA}/members/${ids.ed}`, { role: 'editor' });
  assert.equal((await put('ed', ids.sheetA, 'tabH', { columns: holidayColumns, feeds: 'holidays' })).status, 403, 'an editor without Manage sheets cannot feed Leave');
  assert.equal((await put('ed', ids.sheetA, 'tabH', { columns: holidayColumns })).status, 200, 'but may still define an ordinary table');

  const first = await put('hr', ids.sheetA, 'tabH', { columns: holidayColumns, feeds: 'holidays' });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.feeds, 'holidays');
  const clash = await put('hr', ids.sheetB, 'tabD', { columns: holidayColumns, feeds: 'holidays' });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.takenBy.title, 'Holidays 2027');
  const takeOver = await put('hr', ids.sheetB, 'tabD', { columns: holidayColumns, feeds: 'holidays', replace: true });
  assert.equal(takeOver.status, 200, JSON.stringify(takeOver.json));
  assert.equal((await sheetsApi('hr', 'GET', `/${ids.sheetA}/tables`)).json.tables[0].feeds, null, 'the first one let go');
  assert.equal((await sheetsApi('hr', 'GET', `/${ids.sheetB}/tables`)).json.tables[0].feeds, 'holidays');
  assert.equal((await put('hr', ids.sheetA, 'tabH', { columns: holidayColumns, feeds: 'holidays', replace: true })).status, 200, 'and it can be taken back');
  assert.equal((await put('hr', ids.sheetB, 'tabD', { columns: holidayColumns, feeds: null })).status, 200);
});

test('publishing a table that feeds holidays shows a preview first and changes Leave only after confirming', async (t) => {
  if (skip(t)) return;
  await admin.query("INSERT INTO company_holidays (day, name) VALUES ('2027-01-01', 'New Year'), ('2027-06-12', 'Independence Day'), ('2026-12-25', 'Christmas 2026')");
  const url = `/${ids.sheetA}/tables/holidays/publish`;
  assert.equal((await sheetsApi('ed', 'POST', url, { values: holidayRows })).status, 403, 'publishing a feeding table needs Manage sheets');

  const preview = await sheetsApi('hr', 'POST', url, { values: holidayRows });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.needsConfirm, true);
  assert.equal(preview.json.feeds, 'holidays');
  assert.deepEqual(preview.json.preview.years, [2027]);
  assert.deepEqual(preview.json.preview.add, [{ day: '2027-12-25', name: 'Christmas' }]);
  assert.deepEqual(preview.json.preview.rename, [{ day: '2027-01-01', from: 'New Year', to: 'New Year Day' }]);
  assert.deepEqual(preview.json.preview.remove, [{ day: '2027-06-12', name: 'Independence Day' }]);
  assert.equal((await holidaysOf(2027)).length, 2, 'nothing changed yet');
  assert.equal((await sheetsApi('hr', 'GET', `/${ids.sheetA}/tables/holidays`)).status, 404, 'and nothing was published');

  const done = await sheetsApi('hr', 'POST', url, { values: holidayRows, confirm: true });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual(await holidaysOf(2027), [{ day: '2027-01-01', name: 'New Year Day' }, { day: '2027-12-25', name: 'Christmas' }]);
  assert.deepEqual(await holidaysOf(2026), [{ day: '2026-12-25', name: 'Christmas 2026' }], 'a year the sheet does not cover is left alone');
  assert.equal((await sheetsApi('hr', 'GET', `/${ids.sheetA}/tables/holidays`)).json.rows.length, 2);
});

test('the extra checks for holidays are reported by row and nothing is applied while there are problems', async (t) => {
  if (skip(t)) return;
  const values = [['date', 'name'], ['2027-02-02', 'A'], ['2027-02-02', 'B']];
  const checked = await sheetsApi('hr', 'POST', `/${ids.sheetA}/tables/holidays/check`, { values });
  assert.equal(checked.json.ok, false);
  assert.deepEqual(checked.json.problems.map((p) => [p.row, p.column]), [[3, 'date']]);
  const published = await sheetsApi('hr', 'POST', `/${ids.sheetA}/tables/holidays/publish`, { values, confirm: true });
  assert.equal(published.status, 400);
  assert.equal((await holidaysOf(2027)).length, 2);
});

test('Leave cannot edit the holidays of a year a sheet manages, but other years stay editable, and letting go frees it', async (t) => {
  if (skip(t)) return;
  const listed = await leaveApi('hr', 'GET', '/holidays?year=2027');
  assert.deepEqual(listed.json.managed.years, [2027]);
  assert.equal(listed.json.managed.sheet.title, 'Holidays 2027');
  assert.equal((await leaveApi('hr', 'GET', '/holidays?year=2028')).json.managed.years.includes(2028), false);
  const refused = await leaveApi('hr', 'POST', '/holidays', { day: '2027-03-03', name: 'By hand' });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /Holidays 2027/);
  assert.equal((await leaveApi('hr', 'DELETE', '/holidays/2027-12-25')).status, 409);
  assert.equal((await leaveApi('hr', 'POST', '/holidays', { day: '2028-03-03', name: 'Next year' })).status, 201);
  assert.equal((await leaveApi('hr', 'DELETE', '/holidays/2028-03-03')).status, 200);
  await sheetsApi('hr', 'PUT', `/${ids.sheetA}/tables/holidays`, { tabId: 'tabH', columns: holidayColumns, feeds: null });
  assert.equal((await leaveApi('hr', 'GET', '/holidays?year=2027')).json.managed, null);
  assert.equal((await leaveApi('hr', 'POST', '/holidays', { day: '2027-03-03', name: 'By hand' })).status, 201, 'free again');
  assert.equal((await holidaysOf(2027)).length, 3, 'what was applied stays');
});

test('a table can feed leave credits: bad types are reported, the preview lists new, changed and reset, and Leave edits are refused for those years', async (t) => {
  if (skip(t)) return;
  const sheet = await makeSheet('Credits 2027', 'Credits', [['person', 'leave_type', 'year', 'days']], 'tabC');
  assert.equal((await sheetsApi('hr', 'PUT', `/${sheet}/tables/credits`, { tabId: 'tabC', columns: creditColumns, feeds: 'credits' })).status, 200);
  const type = async (name) => (await admin.query('SELECT id FROM leave_types WHERE name = $1', [name])).rows[0].id;
  const vacation = await type('Vacation Leave');
  await admin.query('INSERT INTO leave_entitlements (user_id, leave_type_id, year, adjustment) VALUES ($1, $2, 2027, 1), ($3, $2, 2027, 2)', [ids.ann, vacation, ids.cy]);

  const bad = await sheetsApi('hr', 'POST', `/${sheet}/tables/credits/check`, { values: [['person', 'leave_type', 'year', 'days'], ['fd-ann', 'Holiday', '2027', '1'], ['fd-bob', 'Vacation Leave', '2027', '1.3']] });
  assert.deepEqual(bad.json.problems.map((p) => [p.row, p.column]), [[2, 'leave_type'], [3, 'days']]);

  const values = [['person', 'leave_type', 'year', 'days'], ['fd-ann', 'vacation leave', '2027', '3'], ['fd-bob', 'Sick Leave', '2027', '1.5']];
  const preview = await sheetsApi('hr', 'POST', `/${sheet}/tables/credits/publish`, { values });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(preview.json.preview.set.map((s) => [s.username, s.typeName, s.adjustment, s.previous]), [['fd-ann', 'Vacation Leave', 3, 1], ['fd-bob', 'Sick Leave', 1.5, 0]]);
  assert.deepEqual(preview.json.preview.reset.map((s) => [s.username, s.previous]), [['fd-cy', 2]]);
  const before = (await admin.query('SELECT COUNT(*)::int AS n FROM leave_entitlements')).rows[0].n;
  assert.equal(before, 2, 'nothing applied by the preview');

  assert.equal((await sheetsApi('hr', 'POST', `/${sheet}/tables/credits/publish`, { values, confirm: true })).status, 200);
  const rows = (await admin.query('SELECT user_id, adjustment::float AS adjustment FROM leave_entitlements WHERE year = 2027 ORDER BY user_id')).rows;
  assert.deepEqual(rows.map((r) => [r.user_id, r.adjustment]), [[ids.ann, 3], [ids.bob, 1.5]], 'cy was reset (removed), ann changed, bob added');
  const balances = await leaveApi('hr', 'GET', `/balances/${ids.ann}?year=2027`);
  assert.equal(balances.json.balances.find((b) => b.name === 'Vacation Leave').adjustment, 3);
  assert.deepEqual(balances.json.managed.years, [2027]);
  const refused = await leaveApi('hr', 'PUT', '/entitlements', { userId: ids.ann, typeId: vacation, year: 2027, adjustment: 9 });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /Credits 2027/);
  assert.equal((await leaveApi('hr', 'PUT', '/entitlements', { userId: ids.ann, typeId: vacation, year: 2028, adjustment: 1 })).status, 200, 'other years stay editable');
});

test('a holidays sheet can start from last year\'s holidays: moved to the new year, declared as the holidays table and set to feed Leave', async (t) => {
  if (skip(t)) return;
  await admin.query("DELETE FROM company_holidays");
  assert.equal((await sheetsApi('ed', 'POST', '/holidays-from-year', { year: 2029 })).status, 403, 'Manage sheets is needed');
  assert.equal((await sheetsApi('hr', 'POST', '/holidays-from-year', { year: 2029 })).status, 400, 'there are no holidays in 2028 to copy');
  assert.equal((await sheetsApi('hr', 'POST', '/holidays-from-year', { year: 1999 })).status, 400);
  await admin.query("INSERT INTO company_holidays (day, name) VALUES ('2028-12-25', 'Christmas'), ('2028-02-29', 'Leap day'), ('2028-01-01', 'New Year')");
  // nothing feeds holidays at the moment (the earlier tests let go), so the new sheet takes it
  await admin.query("UPDATE sheet_tables SET feeds = NULL WHERE feeds = 'holidays'");
  const made = await sheetsApi('hr', 'POST', '/holidays-from-year', { year: 2029 });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.sheet.title, 'Holidays 2029');
  assert.equal(made.json.feeds, true);
  const opened = await sheetsApi('hr', 'GET', `/${made.json.sheet.id}`);
  assert.deepEqual(opened.json.data.tabs[0].rows, [['date', 'name'], ['2029-01-01', 'New Year'], ['2029-02-28', 'Leap day'], ['2029-12-25', 'Christmas']]);
  const tables = (await sheetsApi('hr', 'GET', `/${made.json.sheet.id}/tables`)).json.tables;
  assert.deepEqual(tables.map((x) => [x.name, x.feeds, x.tabName]), [['holidays', 'holidays', 'Holidays']]);
  // the sheet can be published straight away, with a preview first
  const preview = await sheetsApi('hr', 'POST', `/${made.json.sheet.id}/tables/holidays/publish`, { values: opened.json.data.tabs[0].rows });
  assert.equal(preview.json.needsConfirm, true);
  assert.equal(preview.json.preview.add.length, 3);

  const second = await sheetsApi('hr', 'POST', '/holidays-from-year', { year: 2030 });
  assert.equal(second.status, 400, 'there are no holidays in 2029 yet (only the sheet has them)');
  await admin.query("INSERT INTO company_holidays (day, name) VALUES ('2029-05-01', 'Labour Day')");
  const another = await sheetsApi('hr', 'POST', '/holidays-from-year', { year: 2030 });
  assert.equal(another.status, 201);
  assert.equal(another.json.feeds, false, 'a table already feeds holidays, so this one is declared but not connected');
});
