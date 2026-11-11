// IT Avenue Workspace - org chart helpers (pure; covered by test/org-chart.test.js).
//
// People come from GET /api/people with a managerId. The chart is a forest: people with no manager (or
// whose manager is missing or would make a loop) are roots, so a bad record can never hide anyone or hang
// the page.

function orgSortKey(person) {
  return String(person.username || '').toLowerCase();
}

// [{ person, children: [...] }] for the roots, everyone placed exactly once, siblings sorted by name.
function buildOrgTree(people) {
  const byId = new Map();
  for (const person of people) byId.set(Number(person.id), person);

  // find people trapped in a loop (A reports to B reports to A) and make one of them a root
  const parentOf = new Map();
  for (const person of people) {
    const id = Number(person.id);
    const manager = Number(person.managerId);
    parentOf.set(id, byId.has(manager) && manager !== id ? manager : null);
  }
  for (const person of people) {
    const start = Number(person.id);
    const seen = new Set([start]);
    let cursor = parentOf.get(start);
    while (cursor !== null && cursor !== undefined) {
      if (seen.has(cursor)) { parentOf.set(start, null); break; }
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }

  const children = new Map();
  for (const person of people) children.set(Number(person.id), []);
  const roots = [];
  for (const person of people) {
    const parent = parentOf.get(Number(person.id));
    if (parent === null || parent === undefined) roots.push(person);
    else children.get(parent).push(person);
  }
  const bySort = (a, b) => orgSortKey(a).localeCompare(orgSortKey(b));
  const build = (person) => ({ person, children: children.get(Number(person.id)).sort(bySort).map(build) });
  // people with reports first, so the real hierarchy leads and loose individuals follow
  roots.sort((a, b) => (children.get(Number(b.id)).length > 0) - (children.get(Number(a.id)).length > 0) || bySort(a, b));
  return roots.map(build);
}

// The people above someone, nearest manager first: [manager, their manager, ...].
function orgPathAbove(people, id) {
  const byId = new Map(people.map((p) => [Number(p.id), p]));
  const path = [];
  const seen = new Set([Number(id)]);
  let cursor = byId.get(Number(id));
  while (cursor && cursor.managerId && byId.has(Number(cursor.managerId)) && !seen.has(Number(cursor.managerId))) {
    cursor = byId.get(Number(cursor.managerId));
    seen.add(Number(cursor.id));
    path.push(cursor);
  }
  return path;
}

// How many people sit below this node, at any depth.
function orgTeamSize(node) {
  return node.children.reduce((sum, child) => sum + 1 + orgTeamSize(child), 0);
}

// Filter the tree to people whose name, title or department match, keeping the managers above a match.
function filterOrgTree(roots, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return roots;
  const matches = (p) => [p.username, p.jobTitle, p.department, p.location].some((v) => String(v || '').toLowerCase().includes(q));
  const visit = (node) => {
    const kept = node.children.map(visit).filter(Boolean);
    return matches(node.person) || kept.length ? { person: node.person, children: kept, matched: matches(node.person) } : null;
  };
  return roots.map(visit).filter(Boolean);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildOrgTree, orgPathAbove, orgTeamSize, filterOrgTree };
}
