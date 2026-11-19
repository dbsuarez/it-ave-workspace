// How a person is named in text the server builds itself (command cards, exports, search results): their full name, the username only
// as the fallback. The screens do the same through frontend/src/features/display-name.js.

const clean = (value) => String(value ?? '').trim();

// Accepts a database row (first_name...) or an API object (firstName...). '' when the person has no name.
function fullName(person) {
  if (!person) return '';
  return [person.first_name ?? person.firstName, person.middle_name ?? person.middleName, person.last_name ?? person.lastName].map(clean).filter(Boolean).join(' ');
}

function displayName(person) {
  return fullName(person) || clean(person && person.username);
}

// SQL for the full name of the users table under `alias`: NULL when there is no name.
const FULL_NAME_SQL = (alias) => `NULLIF(BTRIM(CONCAT_WS(' ', NULLIF(BTRIM(${alias}.first_name), ''), NULLIF(BTRIM(${alias}.middle_name), ''), NULLIF(BTRIM(${alias}.last_name), ''))), '')`;

module.exports = { fullName, displayName, FULL_NAME_SQL };
