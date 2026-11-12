// IT Avenue Workspace - the rules for managing roles (pure; covered by test/roles.test.js).
//
// Hierarchy: a lower position number is a higher rank. An Owner is rank 0 and manages every role except Owner itself.
// Anyone else manages only roles ranked strictly below their own highest role, and may only give out permissions they hold.
const { PERMISSION_KEYS } = require('./permissions');

const NAME_MAX = 40;
const MAX_CUSTOM_ROLES = 50;

// { isOwner, rank, permissions:Set } from the person's account flags and the roles they hold (Everyone included).
function actorProfile({ isOwner, roles }) {
  let rank = isOwner ? 0 : Infinity;
  const permissions = new Set();
  for (const role of roles) {
    for (const key of role.permissions || []) permissions.add(key);
    if (role.builtin_key !== 'everyone') rank = Math.min(rank, Number(role.position));
  }
  if (isOwner) PERMISSION_KEYS.forEach((key) => permissions.add(key));
  return { isOwner: Boolean(isOwner), rank, permissions };
}

// May this person edit, delete, or give/remove this role?
function canManageRole(actor, role) {
  if (!role || role.builtin_key === 'owner') return false;
  if (actor.isOwner) return true;
  return Number(role.position) > actor.rank;
}

// The permissions this person may not hand out (they do not hold them).
function ungrantable(actor, permissions) {
  return permissions.filter((key) => !actor.permissions.has(key));
}

// A cleaned { name, color, permissions } from a request body, or { error }. `existing` is the role being edited.
function cleanRoleInput(body, existing = null) {
  const input = body || {};
  const builtin = existing && existing.builtin_key;
  let name = existing ? existing.name : '';
  if (!builtin && (input.name !== undefined || !existing)) {
    name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) return { error: 'Give the role a name' };
    if (name.length > NAME_MAX) return { error: `A role name is at most ${NAME_MAX} characters` };
  }
  let color = existing ? existing.color : '#6B21A8';
  if (input.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(input.color))) return { error: 'Choose a color' };
    color = String(input.color).toUpperCase();
  }
  let permissions = existing ? existing.permissions : [];
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions) || input.permissions.some((key) => !PERMISSION_KEYS.includes(key))) {
      return { error: 'Unknown permission in the list' };
    }
    permissions = [...new Set(input.permissions)];
  }
  return { name, color, permissions };
}

module.exports = { NAME_MAX, MAX_CUSTOM_ROLES, actorProfile, canManageRole, ungrantable, cleanRoleInput };
