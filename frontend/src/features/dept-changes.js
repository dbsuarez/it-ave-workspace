// IT Avenue Workspace - Departments dialog: which rows were edited. Pure, so it can be tested without a page.
// Loaded before employees.js, which saves every edited department with the one Save button.

// current: [{ id, name, headId }] as stored; edited: the same shape read back from the dialog.
// A row whose headId is undefined had head text that matched nobody (see headIdFromInput).
// -> { changes: edited rows that differ (name trimmed), blank: ids whose name was cleared, invalid: ids with an unrecognised head }
// Blank and invalid rows are never saved.
function departmentChanges(current, edited) {
  const byId = new Map(current.map((department) => [Number(department.id), department]));
  const normalizeHead = (value) => (value === '' || value === null || value === undefined ? null : Number(value));
  const changes = [];
  const blank = [];
  const invalid = [];
  for (const row of edited) {
    const before = byId.get(Number(row.id));
    if (!before) continue;
    const name = String(row.name ?? '').trim();
    if (!name) { blank.push(Number(row.id)); continue; }
    if (row.headId === undefined) { invalid.push(Number(row.id)); continue; }
    const headId = normalizeHead(row.headId);
    if (name !== before.name || headId !== normalizeHead(before.headId)) changes.push({ id: Number(row.id), name, headId });
  }
  return { changes, blank, invalid };
}

// People for the head search box: alphabetical (ignoring case), "Name (username)" so two people with one name differ.
// people: [{ id, name, username }] -> [{ id, label }]
function employeeOptions(people) {
  return people
    .map((person) => ({ id: Number(person.id), label: person.username ? `${person.name} (${person.username})` : String(person.name) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.id - b.id);
}

// The text typed in the search box -> a person id, null for "no head" (empty), or undefined when it matches nobody exactly.
function headIdFromInput(text, options) {
  const wanted = String(text ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const match = options.find((option) => option.label.toLowerCase() === wanted);
  return match ? match.id : undefined;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { departmentChanges, employeeOptions, headIdFromInput };
}
