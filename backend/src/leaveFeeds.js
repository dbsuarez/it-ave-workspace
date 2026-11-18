// Sheets that feed Leave (docs/superpowers/specs/2026-11-19-sheets-feed-leave-design.md): a published table can be the list of company
// holidays or the leave credits (adjustments) of people. Pure: the rules, the preview plans and the starter shift; the routes do the database.

const FEEDS = {
  holidays: { label: 'Holidays', columns: [{ name: 'date', type: 'date', required: true }, { name: 'name', type: 'text', required: true }] },
  credits: {
    label: 'Leave credits',
    columns: [{ name: 'person', type: 'person', required: true }, { name: 'leave_type', type: 'text', required: true },
      { name: 'year', type: 'number', required: true }, { name: 'days', type: 'number', required: true }],
  },
};

const MAX_HOLIDAY_NAME = 100;
const MAX_ADJUSTMENT = 365;

// null when the declared columns include every required one with the right type (any case, extra columns allowed), else a message.
function feedColumnsProblem(feeds, columns) {
  const feed = FEEDS[feeds];
  if (!feed) return 'Choose what the table feeds: holidays or leave credits';
  for (const need of feed.columns) {
    const found = columns.find((column) => column.name.toLowerCase() === need.name);
    if (!found) return `A table that feeds ${feed.label.toLowerCase()} needs a column called ${need.name} (${need.type})`;
    if (found.type !== need.type) return `The column ${need.name} must be of type ${need.type} to feed ${feed.label.toLowerCase()}`;
  }
  return null;
}

const pick = (row, name) => {
  const key = Object.keys(row).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : row[key];
};

// Extra checks for a feeding table, reported like the ordinary ones. rows are the typed rows, rowNumbers the sheet row of each.
// context.leaveTypes: Map(lowercase name -> name) of the active leave types.
function feedProblems(feeds, rows, rowNumbers, context = {}) {
  const problems = [];
  const report = (row, column, message) => problems.push({ row, column, message });
  const seen = new Map();
  rows.forEach((row, index) => {
    const line = rowNumbers[index];
    let clean = true;
    const bad = (column, message) => { clean = false; report(line, column, message); };
    if (feeds === 'holidays') {
      const day = pick(row, 'date');
      if (String(pick(row, 'name') || '').length > MAX_HOLIDAY_NAME) bad('name', `name can be at most ${MAX_HOLIDAY_NAME} characters`);
      if (clean && seen.has(day)) bad('date', `${day} is already on row ${seen.get(day)}; a day can only be a holiday once`);
      else if (clean) seen.set(day, line);
      return;
    }
    const typeName = String(pick(row, 'leave_type') || '');
    const year = pick(row, 'year');
    const days = pick(row, 'days');
    if (!(context.leaveTypes && context.leaveTypes.has(typeName.toLowerCase()))) bad('leave_type', `"${typeName}" is not a leave type of this workspace`);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) bad('year', `year must be a whole year from 2000 to 2100, not ${year}`);
    if (!Number.isFinite(days) || Math.abs(days) > MAX_ADJUSTMENT || Math.round(days * 2) !== days * 2) bad('days', `days must be a number of days in halves, from -${MAX_ADJUSTMENT} to ${MAX_ADJUSTMENT}`);
    if (!clean) return;
    const key = `${pick(row, 'person')}|${typeName.toLowerCase()}|${year}`;
    if (seen.has(key)) bad('person', `${pick(row, 'person')} already has ${typeName} for ${year} on row ${seen.get(key)}`);
    else seen.set(key, line);
  });
  return problems;
}

const byDay = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);

// rows: typed rows { date, name }; existing: every company holiday [{ day, name }].
function planHolidays(rows, existing) {
  const wanted = new Map(rows.map((row) => [pick(row, 'date'), String(pick(row, 'name'))]));
  const years = [...new Set([...wanted.keys()].map((day) => Number(day.slice(0, 4))))].sort((a, b) => a - b);
  const current = new Map(existing.filter((h) => years.includes(Number(h.day.slice(0, 4)))).map((h) => [h.day, h.name]));
  const add = []; const rename = []; const remove = []; let unchanged = 0;
  for (const [day, name] of wanted) {
    if (!current.has(day)) add.push({ day, name });
    else if (current.get(day) !== name) rename.push({ day, from: current.get(day), to: name });
    else unchanged += 1;
  }
  for (const [day, name] of current) if (!wanted.has(day)) remove.push({ day, name });
  add.sort(byDay); rename.sort(byDay); remove.sort(byDay);
  return { years, add, rename, remove, unchanged };
}

// rows: typed rows { person, leave_type, year, days }; existing: [{ username, typeName, year, adjustment }];
// context.canonicalType: Map(lowercase name -> name).
function planCredits(rows, existing, { canonicalType }) {
  const keyOf = (username, typeName, year) => `${username}|${typeName.toLowerCase()}|${year}`;
  const wanted = rows.map((row) => ({
    username: String(pick(row, 'person')), typeName: canonicalType.get(String(pick(row, 'leave_type')).toLowerCase()) || String(pick(row, 'leave_type')),
    year: pick(row, 'year'), adjustment: pick(row, 'days'),
  }));
  const years = [...new Set(wanted.map((w) => w.year))].sort((a, b) => a - b);
  const current = new Map(existing.map((e) => [keyOf(e.username, e.typeName, e.year), e]));
  const listed = new Set(wanted.map((w) => keyOf(w.username, w.typeName, w.year)));
  const set = []; let unchanged = 0;
  for (const w of wanted) {
    const previous = (current.get(keyOf(w.username, w.typeName, w.year)) || { adjustment: 0 }).adjustment;
    if (previous === w.adjustment) unchanged += 1;
    else set.push({ ...w, previous });
  }
  const reset = existing
    .filter((e) => years.includes(e.year) && e.adjustment !== 0 && !listed.has(keyOf(e.username, e.typeName, e.year)))
    .map((e) => ({ username: e.username, typeName: e.typeName, year: e.year, previous: e.adjustment }));
  return { years, set, reset, unchanged };
}

// Last year's holidays [{ day, name }] moved to `year`: Feb 29 becomes Feb 28, in date order.
function shiftHolidays(holidays, year) {
  return holidays.map((h) => {
    const month = h.day.slice(5, 7);
    let dayOfMonth = h.day.slice(8, 10);
    if (month === '02' && dayOfMonth === '29') dayOfMonth = '28';
    return { day: `${year}-${month}-${dayOfMonth}`, name: h.name };
  }).sort(byDay);
}

// The years a published table covers (sorted), so Leave knows which years the sheet manages.
function feedYears(feeds, rows) {
  const years = rows.map((row) => (feeds === 'holidays' ? Number(String(pick(row, 'date')).slice(0, 4)) : pick(row, 'year')));
  return [...new Set(years.filter((year) => Number.isInteger(year)))].sort((a, b) => a - b);
}

module.exports = { FEEDS, feedColumnsProblem, feedProblems, planHolidays, planCredits, shiftHolidays, feedYears };
