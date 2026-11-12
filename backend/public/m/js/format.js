// Pure helpers shared by the phone app's screens (covered by test/mobile-format.test.js). No DOM in here.

// "First Middle Last", or the username until a name is given.
export function personName(p) {
  const full = [p.firstName, p.middleName, p.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  return full || String(p.username || '');
}

export function initialOf(p) {
  return (personName(p).charAt(0) || '?').toUpperCase();
}

// "Thu, Nov 12" from a plain YYYY-MM-DD (no time zone shifting).
export function dayLabel(value, withYear = false) {
  if (!value) return '';
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], withYear ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
}

export function rangeLabel(start, end) {
  return start === end ? dayLabel(start, true) : `${dayLabel(start)} – ${dayLabel(end, true)}`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

// Monday to Friday between two YYYY-MM-DD days, minus holidays; a half day is 0.5 on one working day.
// The same counting the server does, so the form can show the days before it is sent.
export function workingDays(start, end, halfDay = false, holidays = []) {
  if (!start || !end || end < start) return 0;
  const skip = new Set(holidays.map((h) => h.day || h));
  const [y1, m1, d1] = start.split('-').map(Number);
  const [y2, m2, d2] = end.split('-').map(Number);
  let count = 0;
  for (let t = Date.UTC(y1, m1 - 1, d1); t <= Date.UTC(y2, m2 - 1, d2); t += 86400000) {
    const date = new Date(t);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !skip.has(date.toISOString().slice(0, 10))) count += 1;
  }
  if (halfDay) return start === end && count === 1 ? 0.5 : 0;
  return count;
}

// "08:00–12:00 · 13:00–…" for a day's punches.
export function punchLine(punches) {
  return (punches || []).map((p) => `${p.in}–${p.out || '…'}`).join(' · ');
}

// Hours with up to two decimals, '' for none.
export const hoursText = (minutes) => (minutes ? String(Math.round((minutes / 60) * 100) / 100) : '');

// A short time like "2:05 PM" from an ISO timestamp, or a date when it is not today.
export function whenLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Same-sender messages that arrive within five minutes sit together.
export function groupMessages(messages, senderOf, timeOf) {
  const groups = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    const gap = last ? new Date(timeOf(m)) - new Date(timeOf(last.items[last.items.length - 1])) : Infinity;
    if (last && senderOf(last.items[0]) === senderOf(m) && gap < 5 * 60 * 1000) last.items.push(m);
    else groups.push({ sender: senderOf(m), items: [m] });
  }
  return groups;
}
