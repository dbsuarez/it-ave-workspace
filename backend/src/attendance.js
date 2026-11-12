// Attendance rules, as pure functions (covered by test/attendance-rules.test.js).
//
// One record per person per day: when they clocked in and out. A day is judged against the person's work
// schedule (start, end, break, grace, which weekdays are work days), company holidays and approved leave.
//
//   late      : clocked in after start + grace  -> late minutes count from the start time
//   undertime : clocked out before the end      -> minutes short
//   overtime  : clocked out after the end       -> minutes past the end, once at least overtimeMinMinutes
//   worked    : out - in, minus the break when the stay is longer than five hours
//   Work on a rest day or a holiday is counted as worked time on a premium day (for payroll), not as overtime.

const DAY_MS = 24 * 60 * 60 * 1000;

const minutesBetween = (from, to) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));

function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

// Every date from..to inclusive as 'YYYY-MM-DD'.
function eachDay(from, to) {
  const start = parseDay(from);
  const end = parseDay(to);
  if (!start || !end || end < start) return [];
  const days = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

// 0 = Sunday ... 6 = Saturday, matching the schedule's work_days.
const weekdayOf = (day) => parseDay(day).getUTCDay();

// record: { clockIn: Date, clockOut: Date | null } or null
// schedule: { workDays: [1..5], breakMinutes, graceMinutes, overtimeMinMinutes, start: Date, end: Date } (start/end for that date; only needed with a record)
// leave: days of approved leave on this date (0, 0.5 or 1)
function evaluateDay({ date, today, record, schedule, isHoliday = false, leave = 0 }) {
  const isWorkDay = schedule.workDays.includes(weekdayOf(date));
  const result = {
    date, status: 'rest', isWorkDay, isHoliday, leave,
    lateMinutes: 0, undertimeMinutes: 0, workedMinutes: 0, overtimeMinutes: 0, premiumMinutes: 0, absentDays: 0,
  };

  if (record && record.clockIn) {
    const premium = isHoliday || !isWorkDay;
    if (!premium && record.clockIn.getTime() > schedule.start.getTime() + schedule.graceMinutes * 60000) {
      result.lateMinutes = minutesBetween(schedule.start, record.clockIn);
    }
    if (record.clockOut) {
      const stay = minutesBetween(record.clockIn, record.clockOut);
      result.workedMinutes = stay > 300 ? Math.max(0, stay - schedule.breakMinutes) : stay;
      if (premium) {
        result.premiumMinutes = result.workedMinutes;
      } else {
        if (record.clockOut.getTime() < schedule.end.getTime()) result.undertimeMinutes = minutesBetween(record.clockOut, schedule.end);
        const past = minutesBetween(schedule.end, record.clockOut);
        if (record.clockOut.getTime() > schedule.end.getTime() && past >= schedule.overtimeMinMinutes) result.overtimeMinutes = past;
      }
      result.status = 'present';
    } else {
      result.status = date < today ? 'incomplete' : 'working';
    }
    return result;
  }

  if (isHoliday) { result.status = 'holiday'; return result; }
  if (!isWorkDay) { result.status = 'rest'; return result; }
  if (leave >= 1) { result.status = 'leave'; return result; }
  if (date >= today) { result.status = 'upcoming'; return result; }
  result.status = leave > 0 ? 'leave' : 'absent';
  result.absentDays = 1 - leave;
  return result;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Add up evaluated days (as from evaluateDay). paidLeave / unpaidLeave: maps of date -> days.
function totalsFor(days, { paidLeave = new Map(), unpaidLeave = new Map() } = {}) {
  const t = {
    scheduledDays: 0, presentDays: 0, absentDays: 0, paidLeaveDays: 0, unpaidLeaveDays: 0, holidays: 0,
    lateMinutes: 0, lateCount: 0, undertimeMinutes: 0, workedMinutes: 0, overtimeMinutes: 0, premiumMinutes: 0, incompleteDays: 0,
  };
  for (const d of days) {
    if (d.status === 'n/a') continue;
    if (d.isWorkDay && !d.isHoliday) t.scheduledDays += 1;
    if (d.isHoliday && d.isWorkDay) t.holidays += 1;
    if (d.status === 'present' || d.status === 'working') t.presentDays += 1;
    if (d.status === 'incomplete') t.incompleteDays += 1;
    t.absentDays += d.absentDays;
    t.lateMinutes += d.lateMinutes;
    if (d.lateMinutes > 0) t.lateCount += 1;
    t.undertimeMinutes += d.undertimeMinutes;
    t.workedMinutes += d.workedMinutes;
    t.overtimeMinutes += d.overtimeMinutes;
    t.premiumMinutes += d.premiumMinutes;
    t.paidLeaveDays += paidLeave.get(d.date) || 0;
    t.unpaidLeaveDays += unpaidLeave.get(d.date) || 0;
  }
  t.paidLeaveDays = round2(t.paidLeaveDays);
  t.unpaidLeaveDays = round2(t.unpaidLeaveDays);
  t.absentDays = round2(t.absentDays);
  t.workedHours = round2(t.workedMinutes / 60);
  t.overtimeHours = round2(t.overtimeMinutes / 60);
  t.premiumHours = round2(t.premiumMinutes / 60);
  return t;
}

module.exports = { parseDay, eachDay, weekdayOf, minutesBetween, evaluateDay, totalsFor, round2 };
