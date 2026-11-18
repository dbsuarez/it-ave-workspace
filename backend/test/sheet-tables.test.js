// The rules for a table in a sheet: what a column can be and what a row must look like to be published. Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanColumns, cleanTableName, validateTable, COLUMN_TYPES } = require('../src/sheetTables');

const col = (name, type = 'text', required = false) => ({ name, type, required });
const people = new Map([['ann', 4], ['bob', 5]]);

test('there are five column types', () => {
  assert.deepEqual([...COLUMN_TYPES].sort(), ['date', 'number', 'person', 'text', 'yesno']);
});

test('a table name is lowercase letters, digits and underscores, starting with a letter', () => {
  assert.equal(cleanTableName('holidays'), 'holidays');
  assert.equal(cleanTableName('leave_credits_2027'), 'leave_credits_2027');
  for (const bad of ['', 'Holidays', '1abc', 'has space', 'a-b', 'x'.repeat(41), 5, null, undefined]) assert.throws(() => cleanTableName(bad), /table name/i, String(bad));
});

test('columns need a name and a known type, unique names, and at most 50', () => {
  assert.deepEqual(cleanColumns([{ name: ' Date ', type: 'date', required: true }, { name: 'Note', type: 'text' }]), [col('Date', 'date', true), col('Note', 'text', false)]);
  for (const bad of [[], 'x', [{ name: '', type: 'text' }], [{ name: 'A', type: 'colour' }], [{ name: 'A', type: 'text' }, { name: 'a', type: 'number' }],
    [{ name: 'x'.repeat(61), type: 'text' }], Array.from({ length: 51 }, (_, i) => ({ name: `c${i}`, type: 'text' })), [null]]) {
    assert.throws(() => cleanColumns(bad), /column/i, JSON.stringify(bad).slice(0, 40));
  }
});

test('good rows become typed objects keyed by column name', () => {
  const columns = [col('Date', 'date', true), col('Name', 'text', true), col('Paid', 'yesno'), col('Days', 'number'), col('Owner', 'person')];
  const result = validateTable(columns, [
    ['Date', 'Name', 'Paid', 'Days', 'Owner'],
    ['2027-01-01', 'New Year', 'yes', '1', 'ann'],
    ['2027-12-25', 'Christmas', 'No', '1.5', 'BOB'],
    ['', '', '', '', ''],
    ['2027-06-12', 'Independence Day', '', '', ''],
  ], { people });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.rows, [
    { Date: '2027-01-01', Name: 'New Year', Paid: true, Days: 1, Owner: 'ann' },
    { Date: '2027-12-25', Name: 'Christmas', Paid: false, Days: 1.5, Owner: 'bob' },
    { Date: '2027-06-12', Name: 'Independence Day', Paid: null, Days: null, Owner: null },
  ]);
});

test('every kind of mistake is reported with its row, column and a plain message', () => {
  const columns = [col('Date', 'date', true), col('Days', 'number'), col('Paid', 'yesno'), col('Owner', 'person')];
  const result = validateTable(columns, [
    ['Date', 'Days', 'Paid', 'Owner'],
    ['2027-02-30', 'x', 'maybe', 'nobody'],
    ['', '5', 'yes', 'ann'],
    ['01/02/2027', '1,5', 'y', 'ann'],
  ], { people });
  const text = result.problems.map((p) => `${p.row}:${p.column}:${p.message}`);
  assert.ok(text.some((t) => /^2:Date:.*not a real date/i.test(t)), text.join(' | '));
  assert.ok(text.some((t) => /^2:Days:.*not a number/i.test(t)));
  assert.ok(text.some((t) => /^2:Paid:.*yes or no/i.test(t)));
  assert.ok(text.some((t) => /^2:Owner:.*no person/i.test(t)));
  assert.ok(text.some((t) => /^3:Date:.*required|^3:Date:.*empty/i.test(t)));
  assert.ok(text.some((t) => /^4:Date:.*YYYY-MM-DD/i.test(t)));
  assert.ok(text.some((t) => /^4:Days:.*not a number/i.test(t)), 'a comma is not a decimal point');
  assert.equal(result.rows.length, 0, 'nothing is published while there are problems');
});

test('the header must match the columns, in order', () => {
  const columns = [col('Date', 'date'), col('Name', 'text')];
  const wrong = validateTable(columns, [['Dat', 'Name'], ['2027-01-01', 'x']], { people });
  assert.match(wrong.problems[0].message, /header/i);
  assert.equal(wrong.problems[0].row, 1);
  assert.equal(validateTable(columns, [[' date ', 'NAME'], ['2027-01-01', 'x']], { people }).problems.length, 0, 'case and spaces do not matter');
  assert.match(validateTable(columns, [], { people }).problems[0].message, /header/i, 'an empty tab has no header');
  assert.match(validateTable(columns, [['Date']], { people }).problems[0].message, /header/i, 'a missing column');
});

test('a cell that is still a formula is refused, a table of only a header is fine, and long reports are cut', () => {
  const columns = [col('Total', 'number')];
  assert.match(validateTable(columns, [['Total'], ['=SUM(A1:A3)']], { people }).problems[0].message, /formula/i);
  const headerOnly = validateTable(columns, [['Total']], { people });
  assert.deepEqual([headerOnly.problems, headerOnly.rows], [[], []]);
  const many = validateTable(columns, [['Total'], ...Array.from({ length: 200 }, () => ['x'])], { people });
  assert.equal(many.problems.length, 50);
  assert.equal(many.problemCount, 200, 'but the count is the real one');
});

test('text is kept as typed, trimmed, numbers keep their value, and dates must be real calendar days', () => {
  const columns = [col('A', 'text'), col('B', 'number'), col('C', 'date')];
  const result = validateTable(columns, [['A', 'B', 'C'], ['  hello  ', '-3.25', '2028-02-29'], ['x', '007', '2027-02-29']], { people });
  assert.deepEqual(result.rows, []);
  assert.equal(result.problems.length, 1, '2027 is not a leap year');
  const ok = validateTable(columns, [['A', 'B', 'C'], ['  hello  ', '-3.25', '2028-02-29'], ['x', '007', '']], { people });
  assert.deepEqual(ok.rows, [{ A: 'hello', B: -3.25, C: '2028-02-29' }, { A: 'x', B: 7, C: null }]);
});
