const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDay, workingDaysBetween, leaveDays } = require('../src/leaveDays');

test('only real calendar dates are accepted', () => {
  assert.ok(parseDay('2026-02-28'));
  assert.equal(parseDay('2026-02-30'), null);
  assert.equal(parseDay('26-02-01'), null);
  assert.equal(parseDay(null), null);
});

test('weekends are not leave days', () => {
  // Fri 2026-11-13 to Tue 2026-11-17: Fri, Mon, Tue
  assert.deepEqual(workingDaysBetween('2026-11-13', '2026-11-17'), ['2026-11-13', '2026-11-16', '2026-11-17']);
  assert.deepEqual(workingDaysBetween('2026-11-14', '2026-11-15'), [], 'a weekend alone is nothing');
});

test('company holidays are skipped', () => {
  const holidays = new Set(['2026-11-16']);
  assert.equal(leaveDays('2026-11-13', '2026-11-17', { holidays }), 2);
});

test('a half day counts 0.5, and only on one working day', () => {
  assert.equal(leaveDays('2026-11-16', '2026-11-16', { halfDay: true }), 0.5);
  assert.equal(leaveDays('2026-11-16', '2026-11-17', { halfDay: true }), 0, 'not across two days');
  assert.equal(leaveDays('2026-11-14', '2026-11-14', { halfDay: true }), 0, 'not on a Saturday');
  assert.equal(leaveDays('2026-11-16', '2026-11-16', { halfDay: true, holidays: new Set(['2026-11-16']) }), 0, 'not on a holiday');
});

test('an end before the start, or a bad date, is nothing', () => {
  assert.equal(leaveDays('2026-11-17', '2026-11-16'), 0);
  assert.equal(leaveDays('x', '2026-11-16'), 0);
});

test('it works across a month and a year end', () => {
  assert.equal(leaveDays('2026-12-28', '2027-01-04'), 6); // Mon 28 to Mon 4: 28,29,30,31, 1(Fri), 4
});
