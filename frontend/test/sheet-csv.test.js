const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, rowsToCsv, csvFileName } = require('../src/features/sheet-csv');

test('rows become CSV with commas, quotes and line breaks quoted, and CRLF between rows', () => {
  assert.equal(rowsToCsv([['a', 'b'], ['1', '2']]), 'a,b\r\n1,2\r\n');
  assert.equal(rowsToCsv([['a,b', 'say "hi"', 'two\nlines']]), '"a,b","say ""hi""","two\nlines"\r\n');
  assert.equal(rowsToCsv([['', 'x', '']]), ',x,\r\n');
  assert.equal(rowsToCsv([]), '');
});

test('a cell that could run as a formula in Excel is defused, but ordinary numbers and negatives are not', () => {
  assert.equal(rowsToCsv([['=1+1', '@SUM(A1)', '+cmd', '-cmd']]), "'=1+1,'@SUM(A1),'+cmd,'-cmd\r\n");
  assert.equal(rowsToCsv([['-5', '+3.5', '(12)', '-1,000']]), '-5,+3.5,(12),"-1,000"\r\n');
});

test('CSV is read back into rows: quotes, doubled quotes, commas and line breaks inside cells', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('"a,b","say ""hi""","two\nlines"'), [['a,b', 'say "hi"', 'two\nlines']]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']], 'LF and no final newline');
  assert.deepEqual(parseCsv(',x,'), [['', 'x', '']]);
});

test('a byte order mark is dropped, ragged rows are kept, and nothing gives no rows', () => {
  assert.deepEqual(parseCsv('﻿Name,Days\r\nann,12'), [['Name', 'Days'], ['ann', '12']]);
  assert.deepEqual(parseCsv('a,b,c\r\n1\r\n'), [['a', 'b', 'c'], ['1']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\r\n'), []);
});

test('files with semicolons (some Excel languages) or tabs are read too', () => {
  assert.deepEqual(parseCsv('Name;Days\r\nann;12'), [['Name', 'Days'], ['ann', '12']]);
  assert.deepEqual(parseCsv('Name\tDays\r\nann\t12'), [['Name', 'Days'], ['ann', '12']]);
  assert.deepEqual(parseCsv('"a;b",c\r\n1,2'), [['a;b', 'c'], ['1', '2']], 'a semicolon inside quotes does not change the separator');
});

test('what is exported can be imported again', () => {
  const rows = [['Date', 'Note'], ['2027-01-01', 'New Year, "day off"'], ['', 'multi\nline']];
  assert.deepEqual(parseCsv(rowsToCsv(rows)), rows);
});

test('the file name is the sheet and tab name made safe, with .csv', () => {
  assert.equal(csvFileName('Holidays 2027', 'Sheet1'), 'Holidays_2027-Sheet1.csv');
  assert.equal(csvFileName('a/b: c', ''), 'a_b_c.csv');
  assert.equal(csvFileName('', ''), 'sheet.csv');
});
