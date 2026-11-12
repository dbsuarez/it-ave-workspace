// The HR fields a new account can arrive with (from the import template): employee number, job title, department,
// position level, employment type, hire date, location, phone, who they report to, schedule, remote clocking.
// Pure cleaning and normalizing (covered by test/account-fields.test.js); routes/admin.js stores what comes out.

const EMPLOYMENT_TYPES = ['regular', 'probationary', 'contractual', 'part_time', 'intern'];

function text(value, max, label) {
  if (value === undefined || value === null) return { value: '' };
  if (typeof value !== 'string' && typeof value !== 'number') return { problem: `${label} must be text` };
  const trimmed = String(value).trim();
  if (trimmed.length > max) return { problem: `${label} can be at most ${max} characters` };
  return { value: trimmed };
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function employmentType(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return { value: '' };
  const alias = { parttime: 'part_time', permanent: 'regular', 'full_time': 'regular', fulltime: 'regular', contract: 'contractual', probation: 'probationary', trainee: 'intern', internship: 'intern' };
  const type = alias[key] || key;
  return EMPLOYMENT_TYPES.includes(type) ? { value: type } : { problem: `Unknown employment type "${raw}" (use regular, probationary, contractual, part-time or intern)` };
}

// "Managerial", "manager", "Rank and file", "rank-and-file", "staff" ... -> managerial | rank_and_file; empty means rank and file.
function jobLevel(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return { value: 'rank_and_file' };
  if (/manag|supervis|executive|officer|head|director/.test(key)) return { value: 'managerial' };
  if (/rank|file|staff|rf|employee|associate|clerk/.test(key)) return { value: 'rank_and_file' };
  return { problem: `Unknown position level "${raw}" (use Rank and file or Managerial)` };
}

function yesNo(raw) {
  const key = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (['', 'no', 'n', 'false', '0'].includes(key)) return { value: false };
  if (['yes', 'y', 'true', '1', 'remote'].includes(key)) return { value: true };
  return { problem: `"${raw}" should be yes or no` };
}

// entry: one row from the import (or the API). Returns { fields, problem }; problem is the first thing wrong, in words.
function cleanEmployeeFields(entry) {
  const fields = {};
  const checks = [
    ['employeeNo', text(entry.employeeNo, 40, 'Employee number')],
    ['jobTitle', text(entry.jobTitle, 100, 'Job title')],
    ['location', text(entry.location, 100, 'Location')],
    ['phone', text(entry.phone, 40, 'Phone')],
    ['department', text(entry.department, 100, 'Department')],
    ['schedule', text(entry.schedule, 60, 'Work schedule')],
    ['reportsTo', text(entry.reportsTo, 255, 'Reports to')],
  ];
  for (const [name, result] of checks) {
    if (result.problem) return { problem: result.problem };
    fields[name] = result.value;
  }
  const hire = text(entry.hireDate, 10, 'Hire date');
  if (hire.problem) return { problem: hire.problem };
  if (hire.value && !realDate(hire.value)) return { problem: 'Hire date must be a real date like 2026-01-15' };
  fields.hireDate = hire.value || null;
  for (const [name, result] of [['employmentType', employmentType(entry.employmentType)], ['jobLevel', jobLevel(entry.jobLevel)], ['remoteClock', yesNo(entry.remoteClock)]]) {
    if (result.problem) return { problem: result.problem };
    fields[name] = result.value;
  }
  return { fields };
}

module.exports = { cleanEmployeeFields, employmentType, jobLevel, yesNo, realDate };
