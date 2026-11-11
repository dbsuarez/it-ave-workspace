const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
process.env.JWT_SECRET ||= 'reminders-test-secret';

const { parseRemindAt } = require('../src/routes/reminders');

const NOW = Date.parse('2026-11-11T08:00:00Z');

test('accepts a future time within a year', () => {
  const parsed = parseRemindAt('2026-11-11T09:30:00Z', NOW);
  assert.equal(parsed.toISOString(), '2026-11-11T09:30:00.000Z');
});

test('rejects missing, malformed, past, and far-future times', () => {
  assert.throws(() => parseRemindAt(undefined, NOW), /date and time/);
  assert.throws(() => parseRemindAt('tomorrow-ish', NOW), /valid date/);
  assert.throws(() => parseRemindAt('2026-11-11T08:00:00Z', NOW), /future/);
  assert.throws(() => parseRemindAt('2026-11-10T08:00:00Z', NOW), /future/);
  assert.throws(() => parseRemindAt('2028-01-01T00:00:00Z', NOW), /one year/);
});
