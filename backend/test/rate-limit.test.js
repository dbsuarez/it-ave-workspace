const test = require('node:test');
const assert = require('node:assert/strict');
const { createAttemptLimiter, tooManyMessage, parseTrustProxy } = require('../src/rateLimit');
const { passwordProblem, MIN_PASSWORD_LENGTH } = require('../src/authLimits');

function clock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

test('allows up to max attempts per window, then blocks with a retry time', () => {
  const time = clock();
  const limiter = createAttemptLimiter({ windowMs: 60_000, max: 3, now: time.now });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.check('a').allowed, true);
    limiter.record('a');
    time.advance(1_000);
  }
  const blocked = limiter.check('a');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 57, 'oldest attempt (3s ago) expires in 57s');
  assert.equal(limiter.check('b').allowed, true, 'keys are independent');
});

test('attempts expire out of the window', () => {
  const time = clock();
  const limiter = createAttemptLimiter({ windowMs: 60_000, max: 2, now: time.now });
  limiter.record('k');
  limiter.record('k');
  assert.equal(limiter.check('k').allowed, false);
  time.advance(60_001);
  assert.equal(limiter.check('k').allowed, true);
  assert.equal(limiter.size(), 0, 'expired keys are dropped');
});

test('check does not record, reset forgets a key, memory is bounded', () => {
  const time = clock();
  const limiter = createAttemptLimiter({ windowMs: 60_000, max: 1, maxKeys: 3, now: time.now });
  for (let i = 0; i < 10; i += 1) limiter.check('x');
  assert.equal(limiter.check('x').allowed, true);
  limiter.record('x');
  assert.equal(limiter.check('x').allowed, false);
  limiter.reset('x');
  assert.equal(limiter.check('x').allowed, true);
  ['a', 'b', 'c', 'd', 'e'].forEach((key) => limiter.record(key));
  assert.equal(limiter.size(), 3);
  assert.equal(limiter.check('a').allowed, true, 'oldest keys were evicted');
});

test('wait messages round up to whole minutes', () => {
  assert.equal(tooManyMessage(1), 'Too many attempts. Try again in about 1 minute.');
  assert.equal(tooManyMessage(61), 'Too many attempts. Try again in about 2 minutes.');
});

test('TRUST_PROXY accepts hop counts and named ranges only', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy(' 2 '), 2);
  assert.equal(parseTrustProxy('Loopback'), 'loopback');
  for (const unsafe of ['true', '10.0.0.0/8', '*', '100', 'yes']) {
    assert.equal(parseTrustProxy(unsafe), false, unsafe);
  }
});

test('password policy', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.equal(passwordProblem('longenough1'), null);
  assert.match(passwordProblem('short'), /at least 8/);
  assert.match(passwordProblem('x'.repeat(129)), /at most 128/);
  assert.match(passwordProblem('Pa55word!', 'pa55word!'), /same as your username/);
  assert.match(passwordProblem(undefined), /required/);
  assert.match(passwordProblem(12345678), /required/);
});
