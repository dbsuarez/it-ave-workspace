// IT Avenue Workspace - how a person is shown anywhere in the app: their full name (first, middle, last), and the username only when
// there is no name. The app never prints a bare username as a person's label. Pure lookup (tested); `displayName` below uses what
// the app knows (the signed-in person and the people it has loaded).

const nameParts = (person) => [person.firstName, person.middleName, person.lastName].map((part) => String(part || '').trim()).filter(Boolean).join(' ');

// ref: a username, or { id | userId, username, name?, firstName? ... }. Returns the full name, else the username, else fallback.
function resolveDisplayName(people, me, ref, fallback = '') {
  if (ref === null || ref === undefined || ref === '') return fallback;
  const given = typeof ref === 'string' ? { username: ref } : ref;
  if (given.name && String(given.name).trim()) return String(given.name).trim();
  const own = nameParts(given);
  if (own) return own;
  const id = given.id ?? given.userId;
  const username = String(given.username || '').toLowerCase();
  const pool = [...(me ? [me] : []), ...(Array.isArray(people) ? people : [])];
  const found = pool.find((p) => (id !== undefined && id !== null && Number(p.id) === Number(id)))
    || (username ? pool.find((p) => String(p.username || '').toLowerCase() === username) : null);
  return (found && nameParts(found)) || given.username || (found && found.username) || fallback;
}

// In the app: the same, from the loaded people and the signed-in person.
function displayName(ref, fallback = '') {
  const known = typeof state !== 'undefined' && state ? state : {};
  return resolveDisplayName(known.users, known.user, ref, fallback);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveDisplayName };
}
