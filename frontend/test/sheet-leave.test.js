const test = require('node:test');
const assert = require('node:assert/strict');
const { leaveRecordsToRows, LEAVE_SHEET_HEADER, leaveManagedNote } = require('../src/features/sheet-leave');

const record = (extra = {}) => ({
  employeeNo: 'E-07', firstName: 'Ann', middleName: '', lastName: 'Lee', username: 'ann', department: 'MIS', typeName: 'Vacation',
  startDate: '2027-03-01', endDate: '2027-03-03', days: 3, halfDay: false, status: 'approved', reason: 'Trip', ...extra,
});

test('the leave records become a header row and one row per request, as plain text', () => {
  const rows = leaveRecordsToRows([record()]);
  assert.deepEqual(rows[0], LEAVE_SHEET_HEADER);
  assert.deepEqual(rows[1], ['E-07', 'Ann Lee', 'MIS', 'Vacation', '2027-03-01', '2027-03-03', '3', '', 'approved', 'Trip']);
  assert.ok(rows.every((row) => row.every((cell) => typeof cell === 'string')));
});

test('the name is the full name, or the username when there is none; a half day says yes', () => {
  assert.equal(leaveRecordsToRows([record({ firstName: 'Ann', middleName: 'M.', lastName: 'Lee' })])[1][1], 'Ann M. Lee');
  assert.equal(leaveRecordsToRows([record({ firstName: '', lastName: '' })])[1][1], 'ann');
  assert.equal(leaveRecordsToRows([record({ halfDay: true, days: 0.5 })])[1][7], 'yes');
  assert.equal(leaveRecordsToRows([record({ days: 0.5 })])[1][6], '0.5');
});

test('only pending and approved leave is kept by default, earliest first', () => {
  const rows = leaveRecordsToRows([
    record({ startDate: '2027-05-01', employeeNo: 'late' }), record({ status: 'rejected', employeeNo: 'no' }), record({ status: 'cancelled', employeeNo: 'no2' }),
    record({ startDate: '2027-02-01', status: 'pending', employeeNo: 'early' }),
  ]);
  assert.deepEqual(rows.slice(1).map((row) => row[0]), ['early', 'late']);
  assert.equal(leaveRecordsToRows([record({ status: 'rejected' })], { statuses: ['rejected'] }).length, 2);
});

test('missing values become empty cells and a date keeps only its day', () => {
  const rows = leaveRecordsToRows([record({ employeeNo: null, department: undefined, reason: null, startDate: '2027-03-01T00:00:00.000Z', endDate: '2027-03-02T00:00:00.000Z' })]);
  assert.deepEqual([rows[1][0], rows[1][2], rows[1][9], rows[1][4], rows[1][5]], ['', '', '', '2027-03-01', '2027-03-02']);
  assert.deepEqual(leaveRecordsToRows([]), [LEAVE_SHEET_HEADER]);
});

test('Leave says which sheet manages a year, and says nothing for other years or when no sheet does', () => {
  const managed = { years: [2027], sheet: { id: 4, title: 'Holidays 2027' }, table: 'holidays' };
  assert.match(leaveManagedNote(managed, 2027), /Holidays 2027/);
  assert.equal(leaveManagedNote(managed, 2028), '');
  assert.equal(leaveManagedNote(null, 2027), '');
  assert.equal(leaveManagedNote(undefined, 2027), '');
});
