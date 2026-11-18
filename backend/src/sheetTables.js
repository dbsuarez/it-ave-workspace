// Sheets: the rules for a table in a sheet (docs/superpowers/specs/2026-11-19-sheets-design.md). A tab can be declared a table: its
// first row is the header, and each column has a name and a type. Publishing checks every row against that and, when all is well,
// saves the typed rows. Pure: no database and no clock here (the people to match are passed in).

const COLUMN_TYPES = new Set(['text', 'number', 'date', 'yesno', 'person']);
const MAX_COLUMNS = 50;
const MAX_COLUMN_NAME = 60;
const MAX_REPORTED = 50;

const fail = (status, message) => Object.assign(new Error(message), { status });

function cleanTableName(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(value)) {
    throw fail(400, 'A table name is lowercase letters, digits and underscores, starting with a letter (at most 40 characters)');
  }
  return value;
}

// [{ name, type, required }] checked and cleaned.
function cleanColumns(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_COLUMNS) throw fail(400, `A table has 1 to ${MAX_COLUMNS} columns`);
  const seen = new Set();
  return list.map((column) => {
    const name = column && typeof column.name === 'string' ? column.name.trim() : '';
    if (!name || name.length > MAX_COLUMN_NAME) throw fail(400, `Every column needs a name of 1 to ${MAX_COLUMN_NAME} characters`);
    if (!column || !COLUMN_TYPES.has(column.type)) throw fail(400, `The column ${name} needs a type: text, number, date, yesno or person`);
    if (seen.has(name.toLowerCase())) throw fail(400, `Two columns cannot both be called ${name}`);
    seen.add(name.toLowerCase());
    return { name, type: column.type, required: Boolean(column.required) };
  });
}

const isRealDate = (text) => {
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

// One cell: { value } or { error } (the message starts with what is wrong, the caller adds the column name).
function readCell(column, text, people) {
  if (!text) return column.required ? { error: 'is required but this cell is empty' } : { value: null };
  if (text.startsWith('=')) return { error: 'is still a formula; only values can be published, so check the sheet shows a result' };
  if (column.type === 'text') return { value: text };
  if (column.type === 'number') return /^[+-]?\d+(\.\d+)?$/.test(text) ? { value: Number(text) } : { error: `"${text}" is not a number (use a decimal point, for example 1.5)` };
  if (column.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { error: `"${text}" must be written YYYY-MM-DD, for example 2027-01-31` };
    return isRealDate(text) ? { value: text } : { error: `"${text}" is not a real date` };
  }
  if (column.type === 'yesno') {
    const lower = text.toLowerCase();
    if (['yes', 'true', '1'].includes(lower)) return { value: true };
    if (['no', 'false', '0'].includes(lower)) return { value: false };
    return { error: `"${text}" must be yes or no` };
  }
  const key = text.toLowerCase();
  return people && people.has(key) ? { value: key } : { error: `no person with the username "${text}"` };
}

const cellText = (row, index) => (row && row[index] !== undefined && row[index] !== null ? String(row[index]).trim() : '');

// values: the tab as the sheet shows it (rows of cell text, results rather than formulas). -> { rows, problems, problemCount }
// rows are objects keyed by column name and are empty when there are problems: nothing is published until it is all clean.
function validateTable(columns, values, { people } = {}) {
  const problems = [];
  let problemCount = 0;
  const report = (row, column, message) => { problemCount += 1; if (problems.length < MAX_REPORTED) problems.push({ row, column, message }); };

  const header = values[0];
  const expected = columns.map((column) => column.name).join(', ');
  if (!header) report(1, '', `The header row is missing: the first row must be ${expected}`);
  else {
    columns.forEach((column, index) => {
      if (cellText(header, index).toLowerCase() !== column.name.toLowerCase()) {
        report(1, column.name, `The header row must be ${expected}; the cell for ${column.name} says "${cellText(header, index)}"`);
      }
    });
  }
  const rows = [];
  for (let r = 1; r < values.length; r += 1) {
    if (columns.every((column, index) => cellText(values[r], index) === '')) continue; // an empty row is skipped
    const row = {};
    columns.forEach((column, index) => {
      const result = readCell(column, cellText(values[r], index), people);
      if (result.error) report(r + 1, column.name, `${column.name} ${result.error}`);
      else row[column.name] = result.value;
    });
    rows.push(row);
  }
  return { rows: problemCount ? [] : rows, problems, problemCount };
}

module.exports = { COLUMN_TYPES, cleanTableName, cleanColumns, validateTable };
