const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
process.env.JWT_SECRET ||= 'integrations-test-secret';

const { allowWebhookCall } = require('../src/routes/webhooks');
const { isValidGroupHandle } = require('../src/routes/userGroups');

test('webhook calls are limited per minute and recover after the window', () => {
  const start = 1_000_000;
  for (let i = 0; i < 3; i += 1) assert.equal(allowWebhookCall('t1', start + i, 3), true);
  assert.equal(allowWebhookCall('t1', start + 10, 3), false);
  assert.equal(allowWebhookCall('other', start + 10, 3), true, 'limits are per webhook');
  assert.equal(allowWebhookCall('t1', start + 61_000, 3), true);
});

test('group handles are short lowercase slugs', () => {
  for (const handle of ['support', 'dev-team', 'a1']) assert.equal(isValidGroupHandle(handle), true, handle);
  for (const handle of ['A', 'Support', 'with space', '-lead', 'x', '', null, 'a'.repeat(32)]) {
    assert.equal(isValidGroupHandle(handle), false, String(handle));
  }
});
