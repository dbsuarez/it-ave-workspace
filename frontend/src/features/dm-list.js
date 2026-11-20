// IT Avenue Workspace - the Direct Messages list: only the people you have a conversation with, the latest conversation first, plus a search
// that finds employees (members only) to start a new one. Pure and tested (frontend/test/dm-list.test.js); renderer.js draws it.
// partners: [{ userId, lastAt }] from GET /api/users/dm-partners, newest first.

// The users to list, in order. A chat you opened but have not written in yet (openId) shows at the top until it has a message.
function dmConversationUsers({ users, partners, openId, meId }) {
  const byId = new Map((users || []).map((user) => [Number(user.id), user]));
  const list = [];
  const seen = new Set();
  for (const partner of partners || []) {
    const user = byId.get(Number(partner.userId));
    if (user && Number(user.id) !== Number(meId) && !seen.has(Number(user.id))) { list.push(user); seen.add(Number(user.id)); }
  }
  const open = openId == null ? null : byId.get(Number(openId));
  if (open && Number(open.id) !== Number(meId) && !seen.has(Number(open.id))) list.unshift(open);
  return list;
}

// The partner list after a message with this person: they move to the top (or join it). The old list is not changed.
function dmBumpPartner(partners, userId, iso) {
  return [{ userId: Number(userId), lastAt: iso }, ...(partners || []).filter((partner) => Number(partner.userId) !== Number(userId))];
}

// Employees whose full name or username contains every word typed. Alphabetical; never you, a guest or a bot; nothing for an empty search.
function dmSearchEmployees({ users, query, meId, nameOf, limit = 30 }) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return (users || [])
    .filter((user) => user.accountType === 'member' && Number(user.id) !== Number(meId))
    .map((user) => ({ user, name: nameOf(user) }))
    .filter(({ user, name }) => { const text = `${name} ${user.username || ''}`.toLowerCase(); return words.every((word) => text.includes(word)); })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ user }) => user);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { dmConversationUsers, dmBumpPartner, dmSearchEmployees };
}
