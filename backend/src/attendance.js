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
//   Managerial staff (overtimeEligible false) earn neither overtime nor premium time; their hours are still counted.

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

// punches: [{ clockIn: Date, clockOut: Date | null }] in order (empty or missing: no record that day)
// schedule: { workDays: [1..5], breakMinutes, graceMinutes, overtimeMinMinutes, start: Date, end: Date } (start/end for that date; needed only with punches)
// leave: days of approved leave on this date (0, 0.5 or 1)
// overtimeEligible: false for managerial staff: no overtime and no rest-day/holiday premium, though the hours are still counted
//
// People clock in and out several times a day (in 8:00, out 12:00 for lunch, in 13:00, out 17:00). Worked time is the sum
// of the stretches. A stay of more than five hours in one stretch had no break punched, so the scheduled break comes off.
// Time away between stretches over the break allowance (plus grace) is "over break".
function evaluateDay({ date, today, punches, schedule, isHoliday = false, leave = 0, overtimeEligible = true }) {
  const isWorkDay = schedule.workDays.includes(weekdayOf(date));
  const result = {
    date, status: 'rest', isWorkDay, isHoliday, leave,
    lateMinutes: 0, undertimeMinutes: 0, workedMinutes: 0, overtimeMinutes: 0, afterHoursMinutes: 0, premiumMinutes: 0,
    overBreakMinutes: 0, absentDays: 0, overtimeEligible,
  };
  const list = (punches || []).filter((p) => p && p.clockIn);

  if (list.length) {
    const premium = isHoliday || !isWorkDay;
    const first = list[0];
    const open = list.some((p) => !p.clockOut);
    const closed = list.filter((p) => p.clockOut);
    if (!premium && first.clockIn.getTime() > schedule.start.getTime() + schedule.graceMinutes * 60000) {
      result.lateMinutes = minutesBetween(schedule.start, first.clockIn);
    }
    let worked = closed.reduce((sum, p) => sum + minutesBetween(p.clockIn, p.clockOut), 0);
    if (list.length === 1 && closed.length === 1 && worked > 300) worked = Math.max(0, worked - schedule.breakMinutes);
    result.workedMinutes = worked;
    // time away between stretches
    let away = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (list[i - 1].clockOut) away += minutesBetween(list[i - 1].clockOut, list[i].clockIn);
    }
    if (list.length > 1 && !premium && away > schedule.breakMinutes + schedule.graceMinutes) result.overBreakMinutes = away - schedule.breakMinutes;

    if (open) {
      result.status = date < today ? 'incomplete' : 'working';
      return result;
    }
    const last = closed[closed.length - 1];
    if (premium) {
      if (overtimeEligible) result.premiumMinutes = worked;
    } else {
      if (last.clockOut.getTime() < schedule.end.getTime()) result.undertimeMinutes = minutesBetween(last.clockOut, schedule.end);
      const past = minutesBetween(schedule.end, last.clockOut);
      if (last.clockOut.getTime() > schedule.end.getTime() && past >= schedule.overtimeMinMinutes) {
        if (overtimeEligible) result.overtimeMinutes = past; else result.afterHoursMinutes = past;
      }
    }
    result.status = 'present';
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
    lateMinutes: 0, lateCount: 0, undertimeMinutes: 0, workedMinutes: 0, overtimeMinutes: 0, afterHoursMinutes: 0, premiumMinutes: 0, overBreakMinutes: 0, incompleteDays: 0,
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
    t.afterHoursMinutes += d.afterHoursMinutes || 0;
    t.premiumMinutes += d.premiumMinutes;
    t.overBreakMinutes += d.overBreakMinutes || 0;
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
