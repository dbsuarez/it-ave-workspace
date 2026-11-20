// IT Avenue Workspace - the Permissions card on a channel in Moderation (docs/ROLES_DESIGN.md, phase 3).
//
// One row per role (and per person with their own settings), one column per channel permission. Each cell is Inherit
// (use what the role gives), Allow or Deny. Changes save at once. The card is hidden for anyone who may not change them.

const channelPermState = { channelId: null, permissions: [], roles: [], departments: [], people: [], tab: 'roles' };

// A department only decides who can see and read the channel (the server refuses anything else for a department).
const DEPARTMENT_PERMISSION_KEY = 'view_channel';

// What the signed-in person may do in the open channel: { sendMessages, attachFiles, addReactions } from
// GET /api/channels/:id/my-permissions, or null while it is not known (then nothing is locked). The screen disables what they cannot do.
function composerLockReason(perms) {
  return perms && perms.sendMessages === false ? "You don't have permission to send messages in this channel" : null;
}

// How the composer behaves: 'open', 'commands' (sending is denied, but slash commands still work: they run on the server and reply to
// the person alone), or 'locked' (a locked or archived topic). forumReason is the reason a forum topic gives, if any.
function composerMode(perms, forumReason) {
  if (forumReason) return { mode: 'locked', reason: forumReason };
  const reason = composerLockReason(perms);
  return reason ? { mode: 'commands', reason } : { mode: 'open', reason: null };
}

// In commands-only mode: an empty box or a command (one slash, then the command) is fine; anything else is a message.
function commandsOnlyAllows(text) {
  const trimmed = String(text || '').trim();
  return trimmed === '' || (trimmed.startsWith('/') && !trimmed.startsWith('//'));
}

function attachBlockedReason(perms) {
  return perms && perms.attachFiles === false ? "You don't have permission to attach files in this channel" : null;
}

function reactionsBlockedReason(perms) {
  return perms && perms.addReactions === false ? "You don't have permission to add reactions in this channel" : null;
}

// Departments grant access to see the channel only (the server refuses anything else); roles and people can have any of them.
function permAppliesTo(type, key) {
  return !(type === 'department' && key !== 'view_channel');
}

function permCell(item, key, type = 'role') {
  if (!permAppliesTo(type, key)) return '<td class="role-col perm-na" title="Departments grant access to the channel only; set this for a role or a person">&mdash;</td>';
  const value = item.deny.includes(key) ? 'deny' : item.allow.includes(key) ? 'allow' : 'inherit';
  return `<td class="role-col"><select class="perm-select perm-${value}" data-perm-key="${escapeHtml(key)}" aria-label="${escapeHtml(key)}">
    <option value="inherit"${value === 'inherit' ? ' selected' : ''}>Inherit</option>
    <option value="allow"${value === 'allow' ? ' selected' : ''}>Allow</option>
    <option value="deny"${value === 'deny' ? ' selected' : ''}>Deny</option></select></td>`;
}

// The allow and deny lists of a row once one permission is set to inherit, allow or deny (the others stay as they are).
function permApplyValue(item, key, value) {
  const allow = item.allow.filter((entry) => entry !== key);
  const deny = item.deny.filter((entry) => entry !== key);
  if (value === 'allow') allow.push(key);
  else if (value === 'deny') deny.push(key);
  return { allow, deny };
}

function permBulkSummary(label, value, count) {
  const word = value === 'allow' ? 'Allow' : value === 'deny' ? 'Deny' : 'Inherit';
  return `Set "${label}" to ${word} for ${count} row${count === 1 ? '' : 's'}? Each row's other permissions stay as they are.`;
}

function renderChannelPermissions() {
  const host = document.getElementById('moderation-channel-permissions');
  if (!host) return;
  const { permissions, roles, departments, people } = channelPermState;
  const bulk = (p) => `<select class="perm-bulk" data-perm-bulk="${escapeHtml(p.key)}" aria-label="Set ${escapeHtml(p.label)} for everyone" title="Set ${escapeHtml(p.label)} for every row"><option value="">Set all…</option><option value="inherit">Inherit</option><option value="allow">Allow</option><option value="deny">Deny</option></select>`;
  const tab = channelPermState.tab === 'departments' ? 'departments' : 'roles';
  const shown = tab === 'departments' ? permissions.filter((p) => p.key === DEPARTMENT_PERMISSION_KEY) : permissions;
  const head = `<tr><th>Who</th>${shown.map((p) => `<th class="role-col" title="${escapeHtml(p.label)}"><div>${escapeHtml(p.label)}</div>${bulk(p)}</th>`).join('')}<th></th></tr>`;
  const roleRows = roles.map((r) => `<tr data-perm-type="role" data-perm-id="${r.id}">
    <td><span class="role-dot" style="background:${escapeHtml(r.color)}"></span> <strong>${escapeHtml(r.name)}</strong></td>
    ${shown.map((p) => permCell(r, p.key)).join('')}<td></td></tr>`).join('');
  const departmentRows = departments.map((department) => `<tr data-perm-type="department" data-perm-id="${department.id}">
    <td><strong>${escapeHtml(department.name)}</strong><small>Department · ${Number(department.memberCount || 0)} member${Number(department.memberCount || 0) === 1 ? '' : 's'}</small></td>
    ${shown.map((permission) => permCell(department, permission.key, 'department')).join('')}<td></td></tr>`).join('');
  const personRows = people.map((p) => `<tr data-perm-type="user" data-perm-id="${p.id}">
    <td><strong>${escapeHtml(p.name)}</strong><small>Person</small></td>
    ${shown.map((perm) => permCell(p, perm.key)).join('')}
    <td><button type="button" class="btn small" data-perm-remove aria-label="Remove settings for ${escapeHtml(p.name)}">Remove</button></td></tr>`).join('');
  const members = (state.channelMembers && state.channelMembers[channelPermState.channelId]) || [];
  const addable = members.filter((m) => !people.some((p) => p.id === m.id));
  host.innerHTML = `
    <div class="moderation-card">
      <h2>Permissions</h2>
      <div class="perm-tabs" role="tablist">
        <button type="button" class="pp-tab${tab === 'roles' ? ' active' : ''}" role="tab" data-perm-tab="roles">Roles &amp; people</button>
        <button type="button" class="pp-tab${tab === 'departments' ? ' active' : ''}" role="tab" data-perm-tab="departments">Departments</button>
      </div>
      ${tab === 'departments'
        ? `<p class="moderation-help">A department only decides who can <strong>see and read</strong> this channel. Allow gives everyone in that department access; Deny blocks them; Inherit leaves it to their roles. Department membership follows each employee's current HR department automatically. What people can do (send, attach, react) is set on the Roles &amp; people tab.</p>`
        : `<p class="moderation-help">Choose what each role or person can do in this channel. Inherit means "whatever their role allows". Deny beats Inherit; a person's own setting beats their roles.</p>`}
      <div class="role-table-wrap"><table class="role-table"><thead>${head}</thead><tbody>${tab === 'departments' ? (departmentRows || '<tr><td colspan="3" class="moderation-help">No departments yet.</td></tr>') : `${roleRows}${personRows}`}</tbody></table></div>
      ${tab === 'departments' ? '' : `<div class="moderation-inline perm-add">
        <select id="perm-add-person" aria-label="Add a person"><option value="">Add a person…</option>${addable.map((m) => `<option value="${m.id}">${escapeHtml(typeof mentionLabel === 'function' ? mentionLabel(m) : m.username)}</option>`).join('')}</select>
        <button type="button" class="btn" data-perm-add>Add person</button>
      </div>`}
    </div>`;
}

async function loadChannelPermissionsCard(channelId) {
  const host = document.getElementById('moderation-channel-permissions');
  if (!host) return;
  channelPermState.channelId = channelId;
  try {
    if (typeof loadChannelMembers === 'function') await loadChannelMembers(channelId);
    const res = await api(`/api/channels/${channelId}/permissions`);
    if (res.status === 403) { host.innerHTML = ''; return; } // not theirs to change
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load permissions');
    channelPermState.permissions = data.permissions;
    channelPermState.roles = data.roles;
    channelPermState.departments = data.departments || [];
    channelPermState.people = data.people;
    renderChannelPermissions();
  } catch (err) {
    console.error('Load channel permissions error:', err);
    host.innerHTML = '';
  }
}

function permListFor(type) {
  return type === 'role' ? channelPermState.roles : type === 'department' ? channelPermState.departments : channelPermState.people;
}

// Saves one row's allow and deny lists. Returns true when it was saved.
async function putChannelPermission(type, id, allow, deny, { quiet = false } = {}) {
  const res = await api(`/api/channels/${channelPermState.channelId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ subjectType: type, subjectId: Number(id), allow, deny }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { if (!quiet) showToast(data.error || 'Could not save.', 'error'); return false; }
  const item = permListFor(type).find((entry) => String(entry.id) === String(id));
  if (item) { item.allow = allow; item.deny = deny; }
  if (typeof loadMyChannelPermissions === 'function') loadMyChannelPermissions(channelPermState.channelId);
  return true;
}

async function saveChannelPermission(row) {
  const select = [...row.querySelectorAll('select[data-perm-key]')];
  const allow = select.filter((s) => s.value === 'allow').map((s) => s.dataset.permKey);
  const deny = select.filter((s) => s.value === 'deny').map((s) => s.dataset.permKey);
  if (await putChannelPermission(row.dataset.permType, row.dataset.permId, allow, deny)) return true;
  loadChannelPermissionsCard(channelPermState.channelId);
  return false;
}

// The "Set all" box in a column header: one permission for every role, department and person row, after the person confirms.
async function setPermissionForAll(key, value) {
  const permission = channelPermState.permissions.find((p) => p.key === key);
  const onDepartments = channelPermState.tab === 'departments';
  const rows = (onDepartments
    ? channelPermState.departments.map((item) => ['department', item])
    : [...channelPermState.roles.map((item) => ['role', item]), ...channelPermState.people.map((item) => ['user', item])]
  ).filter(([type]) => permAppliesTo(type, key));
  if (!permission || !rows.length || !['inherit', 'allow', 'deny'].includes(value)) return;
  if (!(await confirmAction({ title: 'Set for everyone?', message: permBulkSummary(permission.label, value, rows.length), confirmLabel: 'Set all', danger: value === 'deny' }))) return;
  let failed = 0;
  for (const [type, item] of rows) {
    const next = permApplyValue(item, key, value);
    if (!(await putChannelPermission(type, item.id, next.allow, next.deny, { quiet: true }))) failed += 1;
  }
  await loadChannelPermissionsCard(channelPermState.channelId);
  showToast(failed ? `${failed} row${failed === 1 ? '' : 's'} could not be changed.` : `${permission.label} is now ${value === 'inherit' ? 'Inherit' : value === 'allow' ? 'Allow' : 'Deny'} for everyone.`, failed ? 'error' : 'success');
}

if (typeof document !== 'undefined') {
  document.addEventListener('change', async (event) => {
    const bulkSelect = event.target && event.target.closest ? event.target.closest('select[data-perm-bulk]') : null;
    if (bulkSelect) {
      const value = bulkSelect.value;
      bulkSelect.value = '';
      if (value) await setPermissionForAll(bulkSelect.dataset.permBulk, value);
      return;
    }
    const select = event.target && event.target.closest ? event.target.closest('select[data-perm-key]') : null;
    if (!select) return;
    select.className = `perm-select perm-${select.value}`;
    await saveChannelPermission(select.closest('tr'));
  });
  document.addEventListener('click', async (event) => {
    if (!event.target.closest || !event.target.closest('#moderation-channel-permissions')) return;
    const tabButton = event.target.closest('[data-perm-tab]');
    if (tabButton) { channelPermState.tab = tabButton.dataset.permTab === 'departments' ? 'departments' : 'roles'; renderChannelPermissions(); return; }
    const remove = event.target.closest('[data-perm-remove]');
    if (remove) {
      const row = remove.closest('tr');
      row.querySelectorAll('select[data-perm-key]').forEach((s) => { s.value = 'inherit'; });
      if (await saveChannelPermission(row)) await loadChannelPermissionsCard(channelPermState.channelId);
      return;
    }
    if (event.target.closest('[data-perm-add]')) {
      const id = Number(document.getElementById('perm-add-person').value);
      if (!id) return;
      const member = ((state.channelMembers || {})[channelPermState.channelId] || []).find((m) => Number(m.id) === id);
      // a person starts with no settings: add the row, and it is saved when a cell is changed
      channelPermState.people.push({ id, name: member ? (typeof mentionLabel === 'function' ? mentionLabel(member) : member.username) : String(id), allow: [], deny: [] });
      renderChannelPermissions();
    }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { permApplyValue, permBulkSummary, permAppliesTo, composerLockReason, attachBlockedReason, reactionsBlockedReason, composerMode, commandsOnlyAllows };
}
