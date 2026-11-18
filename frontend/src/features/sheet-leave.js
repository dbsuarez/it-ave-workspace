// IT Avenue Workspace - Sheets: turning the leave records into the rows of a sheet, so HR can start a spreadsheet from the current
// leave (a copy to work with, not a live link). Pure and tested; the button that fetches the records and makes the sheet is sheets.js.

const LEAVE_SHEET_HEADER = ['Employee no.', 'Name', 'Department', 'Leave type', 'From', 'To', 'Days', 'Half day', 'Status', 'Reason'];

const leaveText = (value) => (value === null || value === undefined ? '' : String(value));
const leaveDay = (value) => leaveText(value).slice(0, 10);

// records: the requests from GET /api/leave/records. Keeps pending and approved leave (or `statuses`), earliest first.
function leaveRecordsToRows(records, { statuses = ['pending', 'approved'] } = {}) {
  const kept = records.filter((record) => statuses.includes(record.status))
    .sort((a, b) => leaveDay(a.startDate).localeCompare(leaveDay(b.startDate)));
  return [LEAVE_SHEET_HEADER.slice(), ...kept.map((record) => {
    const name = [record.firstName, record.middleName, record.lastName].map((part) => leaveText(part).trim()).filter(Boolean).join(' ') || leaveText(record.username);
    return [
      leaveText(record.employeeNo), name, leaveText(record.department), leaveText(record.typeName), leaveDay(record.startDate), leaveDay(record.endDate),
      leaveText(record.days), record.halfDay ? 'yes' : '', leaveText(record.status), leaveText(record.reason),
    ];
  })];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { leaveRecordsToRows, LEAVE_SHEET_HEADER };
}
