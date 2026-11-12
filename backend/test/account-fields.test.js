const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanEmployeeFields, employmentType, jobLevel, yesNo, realDate } = require('../src/accountFields');

test('position level reads the ways HR writes it; empty means rank and file', () => {
  assert.equal(jobLevel('Managerial').value, 'managerial');
  assert.equal(jobLevel('manager').value, 'managerial');
  assert.equal(jobLevel('Department Head').value, 'managerial');
  assert.equal(jobLevel('Rank and file').value, 'rank_and_file');
  assert.equal(jobLevel('rank-and-file').value, 'rank_and_file');
  assert.equal(jobLevel('Staff').value, 'rank_and_file');
  assert.equal(jobLevel('').value, 'rank_and_file');
  assert.match(jobLevel('wizard').problem, /Unknown position level/);
});

test('employment type accepts spellings and refuses nonsense', () => {
  assert.equal(employmentType('Part-time').value, 'part_time');
  assert.equal(employmentType('part time').value, 'part_time');
  assert.equal(employmentType('Probationary').value, 'probationary');
  assert.equal(employmentType('Contract').value, 'contractual');
  assert.equal(employmentType('').value, '');
  assert.match(employmentType('slave').problem, /Unknown employment type/);
});

test('yes and no, with the usual spellings', () => {
  assert.equal(yesNo('Yes').value, true);
  assert.equal(yesNo('y').value, true);
  assert.equal(yesNo('').value, false);
  assert.equal(yesNo('No').value, false);
  assert.match(yesNo('maybe').problem, /yes or no/);
});

test('dates must be real calendar dates', () => {
  assert.equal(realDate('2026-02-28'), true);
  assert.equal(realDate('2026-02-30'), false);
  assert.equal(realDate('15/01/2026'), false);
});

test('a full row is cleaned, trimmed and normalized', () => {
  const { fields, problem } = cleanEmployeeFields({
    employeeNo: ' E-100 ', jobTitle: 'Analyst', location: 'Lucena', phone: '+63 900 000 0000', department: ' Finance ', schedule: 'Regular',
    reportsTo: 'boss', hireDate: '2026-01-15', employmentType: 'Regular', jobLevel: 'Rank and file', remoteClock: 'no',
  });
  assert.equal(problem, undefined);
  assert.deepEqual(fields, {
    employeeNo: 'E-100', jobTitle: 'Analyst', location: 'Lucena', phone: '+63 900 000 0000', department: 'Finance', schedule: 'Regular', reportsTo: 'boss',
    hireDate: '2026-01-15', employmentType: 'regular', jobLevel: 'rank_and_file', remoteClock: false,
  });
});

test('an empty row is fine (every field is optional), and the first problem is reported', () => {
  const empty = cleanEmployeeFields({});
  assert.equal(empty.problem, undefined);
  assert.deepEqual([empty.fields.hireDate, empty.fields.jobLevel, empty.fields.remoteClock, empty.fields.employmentType], [null, 'rank_and_file', false, '']);
  assert.match(cleanEmployeeFields({ hireDate: '2026-13-01' }).problem, /Hire date/);
  assert.match(cleanEmployeeFields({ jobTitle: 'x'.repeat(101) }).problem, /Job title/);
  assert.match(cleanEmployeeFields({ employmentType: 'zzz' }).problem, /employment type/i);
  assert.match(cleanEmployeeFields({ employeeNo: {} }).problem, /Employee number must be text/);
});
