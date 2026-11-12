const test = require('node:test');
const assert = require('node:assert/strict');
const { eachDay, evaluateDay, totalsFor, minutesBetween } = require('../src/attendance');

// 8:00 to 17:00 on 2026-11-16 (a Monday), written as UTC for the test. Break 12:00-13:00, grace 10, overtime from 30 minutes past the end.
const at = (hhmm, day = '2026-11-16') => new Date(`${day}T${hhmm}:00Z`);
const schedule = (extra = {}) => ({
  workDays: [1, 2, 3, 4, 5], breakMinutes: 60, graceMinutes: 10, overtimeMinMinutes: 30, start: at('08:00'), end: at('17:00'), ...extra,
});
const p = (from, to, day) => ({ clockIn: at(from, day), clockOut: to ? at(to, day) : null });
const day = (over) => evaluateDay({ date: '2026-11-16', today: '2026-11-20', schedule: schedule(), ...over });
// the usual day: in 8:00, out 12:00, in 13:00, out 17:00
const split = (a = '08:00', b = '12:00', c = '13:00', d = '17:00') => [p(a, b), p(c, d)];

test('a normal split day: worked is the two stretches, nothing late, short or over break', () => {
  const d = day({ punches: split() });
  assert.deepEqual([d.status, d.lateMinutes, d.undertimeMinutes, d.overtimeMinutes, d.overBreakMinutes, d.workedMinutes], ['present', 0, 0, 0, 0, 8 * 60]);
});

test('late counts from the start time, but only after the grace period (first clock-in of the day)', () => {
  assert.equal(day({ punches: split('08:10') }).lateMinutes, 0, 'exactly at the grace limit is not late');
  assert.equal(day({ punches: split('08:11') }).lateMinutes, 11);
  assert.equal(day({ punches: split('09:30') }).lateMinutes, 90);
});

test('returning late from the break is over break, not late', () => {
  assert.equal(day({ punches: split('08:00', '12:00', '13:10') }).overBreakMinutes, 0, 'within the grace');
  const d = day({ punches: split('08:00', '12:00', '13:25') });
  assert.deepEqual([d.overBreakMinutes, d.lateMinutes], [25, 0]);
});

test('undertime is measured against the last clock-out; overtime needs the threshold', () => {
  assert.equal(day({ punches: split('08:00', '12:00', '13:00', '16:15') }).undertimeMinutes, 45);
  assert.equal(day({ punches: split('08:00', '12:00', '13:00', '17:20') }).overtimeMinutes, 0, 'under the overtime threshold');
  assert.equal(day({ punches: split('08:00', '12:00', '13:00', '18:30') }).overtimeMinutes, 90);
});

test('managerial staff get no overtime and no premium, but their hours still count', () => {
  const d = day({ punches: split('08:00', '12:00', '13:00', '19:00'), overtimeEligible: false });
  assert.deepEqual([d.overtimeMinutes, d.afterHoursMinutes, d.workedMinutes], [0, 120, 10 * 60]);
  const holiday = day({ isHoliday: true, punches: [p('09:00', '17:00')], overtimeEligible: false });
  assert.deepEqual([holiday.premiumMinutes, holiday.workedMinutes], [0, 7 * 60]);
});

test('one long stretch with no break punched loses the scheduled break; a short one does not', () => {
  assert.equal(day({ punches: [p('08:00', '17:00')] }).workedMinutes, 8 * 60);
  assert.equal(day({ punches: [p('08:00', '12:00')] }).workedMinutes, 240);
});

test('an open stretch: working today, incomplete once the day has passed', () => {
  assert.equal(day({ today: '2026-11-16', punches: [p('08:00', '12:00'), p('13:00', null)] }).status, 'working');
  const old = day({ punches: [p('08:00', '12:00'), p('13:00', null)] });
  assert.deepEqual([old.status, old.workedMinutes], ['incomplete', 240]);
});

test('days without a punch: absent, leave, half-day leave, holiday, rest day, upcoming', () => {
  assert.deepEqual([day({}).status, day({}).absentDays], ['absent', 1]);
  assert.equal(day({ leave: 1 }).status, 'leave');
  const half = day({ leave: 0.5 });
  assert.deepEqual([half.status, half.absentDays], ['leave', 0.5]);
  assert.equal(day({ isHoliday: true }).status, 'holiday');
  assert.equal(evaluateDay({ date: '2026-11-15', today: '2026-11-20', schedule: schedule() }).status, 'rest');
  assert.equal(day({ today: '2026-11-16' }).status, 'upcoming');
});

test('rank-and-file work on a holiday or a rest day is premium time, never late or overtime', () => {
  const holiday = day({ isHoliday: true, punches: [p('10:00', '19:00')] });
  assert.deepEqual([holiday.status, holiday.lateMinutes, holiday.overtimeMinutes, holiday.premiumMinutes], ['present', 0, 0, 8 * 60]);
  const sunday = evaluateDay({ date: '2026-11-15', today: '2026-11-20', schedule: schedule({ start: at('08:00', '2026-11-15'), end: at('17:00', '2026-11-15') }), punches: [p('08:00', '12:00', '2026-11-15')] });
  assert.equal(sunday.premiumMinutes, 240);
});

test('a six-day schedule makes Saturday a work day', () => {
  assert.equal(evaluateDay({ date: '2026-11-14', today: '2026-11-20', schedule: schedule({ workDays: [1, 2, 3, 4, 5, 6] }) }).status, 'absent');
});

test('totals for a period', () => {
  const days = [
    day({ punches: split('08:30', '12:00', '13:30', '17:00') }),
    evaluateDay({ date: '2026-11-17', today: '2026-11-20', schedule: schedule() }),
    evaluateDay({ date: '2026-11-18', today: '2026-11-20', schedule: schedule(), leave: 1 }),
    evaluateDay({ date: '2026-11-19', today: '2026-11-20', schedule: schedule(), isHoliday: true }),
    evaluateDay({ date: '2026-11-21', today: '2026-11-25', schedule: schedule() }),
  ];
  const t = totalsFor(days, { paidLeave: new Map([['2026-11-18', 1]]) });
  assert.deepEqual([t.scheduledDays, t.presentDays, t.absentDays, t.paidLeaveDays, t.holidays, t.lateMinutes, t.lateCount, t.overBreakMinutes], [3, 1, 1, 1, 1, 30, 1, 30]);
  assert.equal(t.workedHours, 7);
});

test('helpers', () => {
  assert.deepEqual(eachDay('2026-11-30', '2026-12-02'), ['2026-11-30', '2026-12-01', '2026-12-02']);
  assert.deepEqual(eachDay('2026-12-02', '2026-11-30'), []);
  assert.equal(minutesBetween(at('09:00'), at('08:00')), 0, 'never negative');
});
