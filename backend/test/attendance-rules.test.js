const test = require('node:test');
const assert = require('node:assert/strict');
const { eachDay, evaluateDay, totalsFor, minutesBetween } = require('../src/attendance');

// 9:00 to 18:00 on 2026-11-16 (a Monday), written as UTC for the test
const at = (hhmm, day = '2026-11-16') => new Date(`${day}T${hhmm}:00Z`);
const schedule = (extra = {}) => ({
  workDays: [1, 2, 3, 4, 5], breakMinutes: 60, graceMinutes: 10, overtimeMinMinutes: 30, start: at('09:00'), end: at('18:00'), ...extra,
});
const day = (over) => evaluateDay({ date: '2026-11-16', today: '2026-11-20', schedule: schedule(), ...over });

test('an on-time day: worked time takes off the break, nothing late, nothing short', () => {
  const d = day({ record: { clockIn: at('08:55'), clockOut: at('18:00') } });
  assert.deepEqual([d.status, d.lateMinutes, d.undertimeMinutes, d.overtimeMinutes, d.workedMinutes], ['present', 0, 0, 0, 8 * 60 + 5]);
});

test('late counts from the start time, but only after the grace period', () => {
  assert.equal(day({ record: { clockIn: at('09:10'), clockOut: at('18:00') } }).lateMinutes, 0, 'exactly at the grace limit is not late');
  assert.equal(day({ record: { clockIn: at('09:11'), clockOut: at('18:00') } }).lateMinutes, 11);
  assert.equal(day({ record: { clockIn: at('10:30'), clockOut: at('18:00') } }).lateMinutes, 90);
});

test('undertime and overtime', () => {
  assert.equal(day({ record: { clockIn: at('09:00'), clockOut: at('17:15') } }).undertimeMinutes, 45);
  assert.equal(day({ record: { clockIn: at('09:00'), clockOut: at('18:20') } }).overtimeMinutes, 0, 'under the overtime threshold');
  assert.equal(day({ record: { clockIn: at('09:00'), clockOut: at('19:30') } }).overtimeMinutes, 90);
});

test('a short stay does not lose the break', () => {
  assert.equal(day({ record: { clockIn: at('09:00'), clockOut: at('12:00') } }).workedMinutes, 180);
});

test('no clock-out: working today, incomplete after the day has passed', () => {
  assert.equal(day({ today: '2026-11-16', record: { clockIn: at('09:00'), clockOut: null } }).status, 'working');
  const old = day({ record: { clockIn: at('09:00'), clockOut: null } });
  assert.deepEqual([old.status, old.workedMinutes], ['incomplete', 0]);
});

test('days without a record: absent, leave, half-day leave, holiday, rest day, upcoming', () => {
  assert.deepEqual([day({}).status, day({}).absentDays], ['absent', 1]);
  assert.equal(day({ leave: 1 }).status, 'leave');
  const half = day({ leave: 0.5 });
  assert.deepEqual([half.status, half.absentDays], ['leave', 0.5], 'half a day on leave and not in: half a day absent');
  assert.equal(day({ isHoliday: true }).status, 'holiday');
  assert.equal(evaluateDay({ date: '2026-11-15', today: '2026-11-20', schedule: schedule() }).status, 'rest');
  assert.equal(day({ today: '2026-11-16' }).status, 'upcoming', 'today, nobody in yet');
  assert.equal(day({ today: '2026-11-10' }).status, 'upcoming');
});

test('work on a holiday or a rest day is premium time, never late or overtime', () => {
  const holiday = day({ isHoliday: true, record: { clockIn: at('11:00'), clockOut: at('20:00') } });
  assert.deepEqual([holiday.status, holiday.lateMinutes, holiday.overtimeMinutes, holiday.premiumMinutes], ['present', 0, 0, 8 * 60]);
  const sunday = evaluateDay({ date: '2026-11-15', today: '2026-11-20', schedule: schedule({ start: at('09:00', '2026-11-15'), end: at('18:00', '2026-11-15') }), record: { clockIn: at('09:00', '2026-11-15'), clockOut: at('13:00', '2026-11-15') } });
  assert.equal(sunday.premiumMinutes, 240);
});

test('a six-day schedule makes Saturday a work day', () => {
  const sat = evaluateDay({ date: '2026-11-14', today: '2026-11-20', schedule: schedule({ workDays: [1, 2, 3, 4, 5, 6] }) });
  assert.equal(sat.status, 'absent');
});

test('totals for a period', () => {
  const days = [
    day({ record: { clockIn: at('09:30'), clockOut: at('18:00') } }),
    evaluateDay({ date: '2026-11-17', today: '2026-11-20', schedule: schedule() }),
    evaluateDay({ date: '2026-11-18', today: '2026-11-20', schedule: schedule(), leave: 1 }),
    evaluateDay({ date: '2026-11-19', today: '2026-11-20', schedule: schedule(), isHoliday: true }),
    evaluateDay({ date: '2026-11-21', today: '2026-11-25', schedule: schedule() }),
  ];
  const t = totalsFor(days, { paidLeave: new Map([['2026-11-18', 1]]) });
  assert.deepEqual([t.scheduledDays, t.presentDays, t.absentDays, t.paidLeaveDays, t.holidays, t.lateMinutes, t.lateCount], [3, 1, 1, 1, 1, 30, 1]);
  assert.equal(t.workedHours, 7.5);
});

test('helpers', () => {
  assert.deepEqual(eachDay('2026-11-30', '2026-12-02'), ['2026-11-30', '2026-12-01', '2026-12-02']);
  assert.deepEqual(eachDay('2026-12-02', '2026-11-30'), []);
  assert.equal(minutesBetween(at('09:00'), at('08:00')), 0, 'never negative');
});
