// Shared limits and password rules for the sign-in and sign-up routes.
const { createAttemptLimiter, tooManyMessage } = require('./rateLimit');

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

// Failed sign-ins only. A person who keeps getting their own password right is never slowed down.
const loginFailuresByAccount = createAttemptLimiter({ windowMs: FIFTEEN_MINUTES, max: 8 });
const loginFailuresByAddress = createAttemptLimiter({ windowMs: FIFTEEN_MINUTES, max: 40 });
// Every sign-up attempt, valid or not.
const registrationAttempts = createAttemptLimiter({ windowMs: ONE_HOUR, max: 15 });
// Public "what does this invitation code grant" lookups.
const invitationLookups = createAttemptLimiter({ windowMs: FIFTEEN_MINUTES, max: 30 });

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// null when acceptable, otherwise the message to show.
function passwordProblem(password, username = '') {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  if (username && password.toLowerCase() === String(username).toLowerCase()) {
    return 'Password cannot be the same as your username';
  }
  return null;
}

function clientAddress(req) {
  return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

function accountKey(req, username) {
  return `${clientAddress(req)}|${String(username || '').trim().toLowerCase().slice(0, 100)}`;
}

// Sends a 429 and returns true when `result` says the caller must wait.
function rejectIfLimited(res, ...results) {
  const blocked = results.find((result) => !result.allowed);
  if (!blocked) return false;
  res.set('Retry-After', String(blocked.retryAfterSec));
  res.status(429).json({ error: tooManyMessage(blocked.retryAfterSec) });
  return true;
}

function resetAllLimits() {
  [loginFailuresByAccount, loginFailuresByAddress, registrationAttempts, invitationLookups]
    .forEach((limiter) => limiter.clear());
}

module.exports = {
  loginFailuresByAccount,
  loginFailuresByAddress,
  registrationAttempts,
  invitationLookups,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  clientAddress,
  accountKey,
  rejectIfLimited,
  resetAllLimits,
};
