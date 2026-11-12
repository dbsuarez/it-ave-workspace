// Counting leave days: working days (Monday to Friday) between two dates, skipping company holidays.
// Dates are plain 'YYYY-MM-DD' strings and are handled as UTC days, so a computer's time zone never shifts them.

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

const formatDay = (date) => date.toISOString().slice(0, 10);

const isWeekend = (date) => date.getUTCDay() === 0 || date.getUTCDay() === 6;

// Every working day from start to end (inclusive) as 'YYYY-MM-DD' strings. holidays: a Set of such strings.
function workingDaysBetween(start, end, holidays = new Set()) {
  const from = parseDay(start);
  const to = parseDay(end);
  if (!from || !to || to < from) return [];
  const days = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    const date = new Date(t);
    const key = formatDay(date);
    if (!isWeekend(date) && !holidays.has(key)) days.push(key);
  }
  return days;
}

// The number of leave days a request uses: working days, or 0.5 for a half day on a single working day.
function leaveDays(start, end, { halfDay = false, holidays = new Set() } = {}) {
  const days = workingDaysBetween(start, end, holidays).length;
  if (halfDay) return start === end && days === 1 ? 0.5 : 0;
  return days;
}

module.exports = { parseDay, formatDay, workingDaysBetween, leaveDays };
