// Small in-memory sliding-window limiter, used to slow down password guessing and
// abuse of the public sign-up endpoints.
//
// State lives in this process only: it resets when the server restarts and is not
// shared between several server processes. That is the right size for this
// deployment; put a gateway rate limit in front if you scale out.

function createAttemptLimiter({ windowMs, max, maxKeys = 10000, now = Date.now }) {
  const hits = new Map(); // key -> ascending list of timestamps

  function live(key, t) {
    const list = hits.get(key);
    if (!list) return [];
    const cutoff = t - windowMs;
    let drop = 0;
    while (drop < list.length && list[drop] <= cutoff) drop += 1;
    if (drop) list.splice(0, drop);
    if (!list.length) {
      hits.delete(key);
      return [];
    }
    return list;
  }

  return {
    // { allowed, retryAfterSec } without recording anything.
    check(key) {
      const t = now();
      const list = live(key, t);
      if (list.length >= max) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
    record(key) {
      const t = now();
      const list = live(key, t);
      list.push(t);
      hits.set(key, list);
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    },
    reset(key) {
      hits.delete(key);
    },
    clear() {
      hits.clear();
    },
    size() {
      return hits.size;
    },
  };
}

function tooManyMessage(retryAfterSec) {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

// Express "trust proxy" setting from the TRUST_PROXY environment variable:
// a number of proxy hops, or one of Express's named ranges. Anything else is off.
function parseTrustProxy(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  if (!text || text === 'false' || text === '0') return false;
  if (/^\d{1,2}$/.test(text)) return Number(text);
  if (['loopback', 'linklocal', 'uniquelocal'].includes(text)) return text;
  return false;
}

module.exports = { createAttemptLimiter, tooManyMessage, parseTrustProxy };
