// Sheets that feed Leave: the required columns, the extra checks, the preview plans and the starter shift. Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FEEDS, feedColumnsProblem, feedProblems, planHolidays, planCredits, shiftHolidays } = require('../src/leaveFeeds');

const col = (name, type, required = false) => ({ name, type, required });
const holidayColumns = [col('date', 'date', true), col('name', 'text', true)];
const creditColumns = [col('person', 'person', true), col('leave_type', 'text', true), col('year', 'number', true), col('days', 'number', true)];

test('there are two kinds of feed, holidays and credits', () => {
  assert.deepEqual(Object.keys(FEEDS).sort(), ['credits', 'holidays']);
});

test('the columns of a feeding table must include the required ones with the right types (any case, extras allowed)', () => {
  assert.equal(feedColumnsProblem('holidays', holidayColumns), null);
  assert.equal(feedColumnsProblem('holidays', [col('Date', 'date'), col('NAME', 'text'), col('note', 'text')]), null);
  assert.match(feedColumnsProblem('holidays', [col('date', 'date')]), /name/);
  assert.match(feedColumnsProblem('holidays', [col('date', 'text'), col('name', 'text')]), /date.*date/i);
  assert.equal(feedColumnsProblem('credits', creditColumns), null);
  assert.match(feedColumnsProblem('credits', creditColumns.slice(0, 3)), /days/);
  assert.match(feedColumnsProblem('nothing', holidayColumns), /feed/i);
});

test('holiday rows: a duplicate date and a long name are reported by row', () => {
  const rows = [{ date: '2027-01-01', name: 'New Year' }, { date: '2027-01-01', name: 'Again' }, { date: '2027-02-02', name: 'x'.repeat(101) }];
  const problems = feedProblems('holidays', rows, [2, 3, 4], {});
  assert.deepEqual(problems.map((p) => [p.row, p.column]), [[3, 'date'], [4, 'name']]);
  assert.match(problems[0].message, /2027-01-01.*row 2/i);
  assert.deepEqual(feedProblems('holidays', rows.slice(0, 1), [2], {}), []);
});

test('credit rows: unknown leave type, bad year, days not in halves, and a repeated person-type-year', () => {
  const leaveTypes = new Map([['vacation leave', 'Vacation Leave'], ['sick leave', 'Sick Leave']]);
  const good = { person: 'ann', leave_type: 'vacation leave', year: 2027, days: 2.5 };
  const problems = feedProblems('credits', [
    good,
    { ...good, leave_type: 'Holiday' },
    { ...good, year: 1999 },
    { ...good, year: 2027.5 },
    { ...good, days: 1.3 },
    { ...good, days: 400 },
    { ...good, leave_type: 'SICK LEAVE' },
    { ...good, leave_type: 'sick leave' },
  ], [2, 3, 4, 5, 6, 7, 8, 9], { leaveTypes });
  const text = problems.map((p) => `${p.row}:${p.column}`);
  assert.deepEqual(text, ['3:leave_type', '4:year', '5:year', '6:days', '7:days', '9:person']);
  assert.match(problems[0].message, /Holiday/);
  assert.match(problems[5].message, /row 8/);
});

test('the holidays plan lists what is added, renamed and removed, only in the years the sheet covers', () => {
  const existing = [
    { day: '2026-12-25', name: 'Christmas 2026' },
    { day: '2027-01-01', name: 'New Year' },
    { day: '2027-04-09', name: 'Valor Day' },
    { day: '2027-06-12', name: 'Independence Day' },
  ];
  const plan = planHolidays([
    { date: '2027-01-01', name: 'New Year' },
    { date: '2027-04-09', name: 'Araw ng Kagitingan' },
    { date: '2027-12-25', name: 'Christmas' },
  ], existing);
  assert.deepEqual(plan.years, [2027]);
  assert.deepEqual(plan.add, [{ day: '2027-12-25', name: 'Christmas' }]);
  assert.deepEqual(plan.rename, [{ day: '2027-04-09', from: 'Valor Day', to: 'Araw ng Kagitingan' }]);
  assert.deepEqual(plan.remove, [{ day: '2027-06-12', name: 'Independence Day' }]);
  assert.equal(plan.unchanged, 1);
});

test('the credits plan lists new and changed adjustments and the ones the sheet no longer lists', () => {
  const existing = [
    { username: 'ann', typeName: 'Vacation Leave', year: 2027, adjustment: 1 },
    { username: 'bob', typeName: 'Vacation Leave', year: 2027, adjustment: 2 },
    { username: 'cy', typeName: 'Sick Leave', year: 2027, adjustment: 0 },
    { username: 'ann', typeName: 'Vacation Leave', year: 2026, adjustment: 5 },
  ];
  const canonicalType = new Map([['vacation leave', 'Vacation Leave'], ['sick leave', 'Sick Leave']]);
  const plan = planCredits([
    { person: 'ann', leave_type: 'VACATION leave', year: 2027, days: 3 },
    { person: 'dee', leave_type: 'Sick Leave', year: 2027, days: 1.5 },
  ], existing, { canonicalType });
  assert.deepEqual(plan.years, [2027]);
  assert.deepEqual(plan.set, [
    { username: 'ann', typeName: 'Vacation Leave', year: 2027, adjustment: 3, previous: 1 },
    { username: 'dee', typeName: 'Sick Leave', year: 2027, adjustment: 1.5, previous: 0 },
  ]);
  assert.deepEqual(plan.reset, [{ username: 'bob', typeName: 'Vacation Leave', year: 2027, previous: 2 }]);
  assert.equal(plan.unchanged, 0);
  const same = planCredits([{ person: 'bob', leave_type: 'vacation leave', year: 2027, days: 2 }], [existing[1]], { canonicalType });
  assert.equal(same.unchanged, 1);
  assert.deepEqual(same.set, []);
});

test('last year\'s holidays move to the new year; Feb 29 becomes Feb 28 and the order is by date', () => {
  const moved = shiftHolidays([
    { day: '2028-12-25', name: 'Christmas' }, { day: '2028-02-29', name: 'Leap day' }, { day: '2028-01-01', name: 'New Year' },
  ], 2029);
  assert.deepEqual(moved, [
    { day: '2029-01-01', name: 'New Year' }, { day: '2029-02-28', name: 'Leap day' }, { day: '2029-12-25', name: 'Christmas' },
  ]);
  assert.deepEqual(shiftHolidays([{ day: '2027-02-28', name: 'a' }], 2028), [{ day: '2028-02-28', name: 'a' }]);
});
