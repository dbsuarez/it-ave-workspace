// IT Avenue Workspace - the Roles panel in Moderation (docs/ROLES_DESIGN.md, phase 2).
//
// Lists the workspace's roles in rank order (highest first), creates and edits them with a permission checklist, moves
// custom roles up and down, and gives custom roles to people. Owner and HR are built in: they are given with the
// Superadmin and HR switches on a person's record. The server enforces the rules; this only shows what is allowed.

const rolesState = { roles: [], permissions: [], people: [], loaded: false };

function roleDot(role) {
  return `<span class="role-dot" style="background:${escapeHtml(role.color)}"></span>`;
}

// Same rule as the server's roleHandle: lowercase, other characters become one hyphen.
function roleHandleOf(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function roleSummary(role) {
  if (role.builtin === 'owner') return 'Everything, always';
  const count = role.permissions.length;
  return count ? `${count} permission${count === 1 ? '' : 's'}` : 'No extra permissions';
}

function renderRolesPanel() {
  const host = document.getElementById('moderation-roles');
  if (!host) return;
  const custom = rolesState.roles.filter((role) => !role.builtin);
  const rows = rolesState.roles.map((role) => {
    const customIndex = custom.findIndex((r) => r.id === role.id);
    const movable = !role.builtin && role.canManage;
    return `<div class="role-row" data-role-id="${role.id}">
      ${roleDot(role)}
      <div class="role-row-main"><strong>${escapeHtml(role.name)}</strong>${role.builtin ? ` <span class="role-tag">Built in</span>` : ''}
        <small>${escapeHtml(roleSummary(role))} · ${role.memberCount} ${role.memberCount === 1 ? 'person' : 'people'}${role.builtin === 'everyone' || role.builtin === 'owner' ? '' : ` · mention with @${escapeHtml(roleHandleOf(role.name))}`}</small></div>
      <div class="role-row-actions">
        ${movable ? `<button type="button" class="btn small" data-role-move="up" ${customIndex <= 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(role.name)} up">&uarr;</button>
        <button type="button" class="btn small" data-role-move="down" ${customIndex === custom.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(role.name)} down">&darr;</button>` : ''}
        ${role.canManage ? '<button type="button" class="btn small" data-role-edit>Edit</button>' : ''}
      </div></div>`;
  }).join('');
  host.innerHTML = `
    <div class="moderation-card roles-card">
      <div class="roles-head"><div><h2>Roles</h2><p class="moderation-help">Highest rank first. Someone can hold several roles and gets everything they allow. People can only manage roles below their own.</p></div>
        <button type="button" class="btn primary" data-role-new>New role</button></div>
      <div class="role-list">${rows || emptyRecordMarkup('No roles yet', 'Create one with New role.')}</div>
    </div>
    <div class="moderation-card roles-card">
      <h2>Who has which role</h2>
      <p class="moderation-help">Tick a box to give or take a role; it saves at once. Owner and HR are shown for reference: they are set on the person's record (Superadmin and HR switches).</p>
      <div class="role-table-tools"><input id="role-table-search" type="search" placeholder="Search people" aria-label="Search people"></div>
      <div class="role-table-wrap" id="role-table-host"><div class="loading-state">Loading…</div></div>
    </div>
    <div class="moderation-card roles-card">
      <h2>Check access</h2>
      <p class="moderation-help">See what a person or a role can do and which channels they can see, with the reason for each answer. This only looks: it does not sign you in as them.</p>
      <div class="access-check-bar">
        <select id="access-subject" aria-label="Person or role">
          <option value="">Choose a person or a role…</option>
          <optgroup label="People">${rolesState.people.map((p) => `<option value="user:${p.id}">${escapeHtml(personName(p))}</option>`).join('')}</optgroup>
          <optgroup label="Roles">${rolesState.roles.map((r) => `<option value="role:${r.id}">${escapeHtml(r.name)}</option>`).join('')}</optgroup>
        </select>
        <button type="button" class="btn primary" data-access-check>Check</button>
      </div>
      <div id="access-result"></div>
    </div>`;
  loadRoleTable();
}

function accessMark(allowed) {
  return allowed ? '<span class="access-yes" aria-label="Allowed">&#10003;</span>' : '<span class="access-no" aria-label="Not allowed">&#10007;</span>';
}

async function runAccessCheck() {
  const value = (document.getElementById('access-subject') || {}).value || '';
  const host = document.getElementById('access-result');
  if (!host) return;
  if (!value) { host.innerHTML = ''; return; }
  const [type, id] = value.split(':');
  host.innerHTML = '<div class="loading-state">Checking…</div>';
  const res = await api(`/api/roles/check?${type === 'role' ? 'roleId' : 'userId'}=${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { host.innerHTML = `<p class="role-error">${escapeHtml(data.error || 'Could not check')}</p>`; return; }
  const keys = data.channelPermissions;
  const own = data.permissions.map((p) => `<tr><td>${accessMark(p.allowed)}</td><td><strong>${escapeHtml(p.label)}</strong></td><td class="access-reason">${escapeHtml(p.reason)}</td></tr>`).join('');
  const chans = data.channels.map((c) => `<tr>
    <td><strong>#${escapeHtml(c.name)}</strong>${c.isPrivate ? ' <span class="role-tag">Private</span>' : ''}<small>${c.member === null ? '' : (c.member ? 'Member' : 'Not a member')}</small></td>
    <td class="role-col">${accessMark(c.visible)}</td>
    ${keys.slice(1).map((k) => `<td class="role-col" title="${escapeHtml(c.checks[k.key].reason)}">${accessMark(c.checks[k.key].allowed)}</td>`).join('')}
    <td class="access-reason">${escapeHtml(c.visible ? (c.checks.send_messages.allowed ? '' : c.checks.send_messages.reason) : (c.member === false && c.checks.view_channel.allowed ? 'Not a member of this channel' : c.checks.view_channel.reason))}</td></tr>`).join('');
  const canViewAs = data.subject.type === 'person' && state.moderation && state.moderation.isSuperadmin && typeof startViewAs === 'function';
  host.innerHTML = `
    <h3 class="access-title">${escapeHtml(data.subject.name)} <span class="role-tag">${data.subject.type === 'role' ? 'Role' : 'Person'}</span>
      ${canViewAs ? `<button type="button" class="btn small" data-view-as="${data.subject.id}">View as ${escapeHtml(data.subject.name)}</button>` : ''}</h3>
    <h4 class="modal-section-title">Workspace</h4>
    <table class="role-table"><tbody>${own}</tbody></table>
    <h4 class="modal-section-title">Channels</h4>
    <p class="moderation-help">Hover a tick or cross to see the reason. A person only sees channels they belong to.</p>
    <div class="role-table-wrap"><table class="role-table"><thead><tr><th>Channel</th><th class="role-col">Can see it</th>${keys.slice(1).map((k) => `<th class="role-col">${escapeHtml(k.label)}</th>`).join('')}<th>Why</th></tr></thead><tbody>${chans}</tbody></table></div>`;
}

const roleTable = { assignments: {}, owners: [], hr: [], query: '' };

async function loadRoleTable() {
  try {
    const res = await api('/api/roles/assignments');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load assignments');
    roleTable.assignments = data.assignments || {};
    roleTable.owners = data.owners || [];
    roleTable.hr = data.hr || [];
    renderRoleTable();
  } catch (err) {
    const host = document.getElementById('role-table-host');
    if (host) host.innerHTML = `<p class="role-error">${escapeHtml(err.message || 'Could not load assignments')}</p>`;
  }
}

function renderRoleTable() {
  const host = document.getElementById('role-table-host');
  if (!host) return;
  const custom = rolesState.roles.filter((role) => !role.builtin);
  const q = roleTable.query.trim().toLowerCase();
  const people = rolesState.people.filter((p) => !q || [personName(p), p.username, p.jobTitle, p.department].some((v) => String(v || '').toLowerCase().includes(q)));
  const head = `<tr><th>Person</th><th class="role-col">Owner</th><th class="role-col">HR</th>${custom.map((r) => `<th class="role-col">${roleDot(r)} ${escapeHtml(r.name)}</th>`).join('')}</tr>`;
  const rows = people.map((p) => {
    const held = new Set(roleTable.assignments[p.id] || []);
    return `<tr data-role-person="${p.id}">
      <td><strong>${escapeHtml(personName(p))}</strong><small>${escapeHtml(p.jobTitle || '')}</small></td>
      <td class="role-col">${roleTable.owners.includes(p.id) ? '&#10003;' : ''}</td>
      <td class="role-col">${roleTable.hr.includes(p.id) ? '&#10003;' : ''}</td>
      ${custom.map((r) => `<td class="role-col"><input type="checkbox" data-role-toggle="${r.id}" aria-label="${escapeHtml(r.name)} for ${escapeHtml(personName(p))}"${held.has(r.id) ? ' checked' : ''}${r.canManage ? '' : ' disabled'}></td>`).join('')}
    </tr>`;
  }).join('');
  host.innerHTML = custom.length
    ? `<table class="role-table"><thead>${head}</thead><tbody>${rows || '<tr><td colspan="3">No one matches.</td></tr>'}</tbody></table>`
    : '<p class="moderation-help">Create a role first, then come back to give it to people.</p>';
}

async function toggleRoleFor(row, box) {
  const personId = Number(row.dataset.rolePerson);
  const roleIds = [...row.querySelectorAll('input[data-role-toggle]:checked')].map((input) => Number(input.dataset.roleToggle));
  const res = await api(`/api/roles/users/${personId}`, { method: 'PUT', body: JSON.stringify({ roleIds }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    box.checked = !box.checked; // put it back
    showToast(data.error || 'Could not save the role.', 'error');
    return;
  }
  roleTable.assignments[personId] = roleIds;
  const counts = {};
  Object.values(roleTable.assignments).forEach((list) => list.forEach((id) => { counts[id] = (counts[id] || 0) + 1; }));
  rolesState.roles.filter((role) => !role.builtin).forEach((role) => {
    role.memberCount = counts[role.id] || 0;
    const el = document.querySelector(`.role-row[data-role-id="${role.id}"] small`);
    if (el) el.textContent = `${roleSummary(role)} · ${role.memberCount} ${role.memberCount === 1 ? 'person' : 'people'}`;
  });
}

// Just the data (no panel): the role list the person's record needs.
async function loadRolesList() {
  const res = await api('/api/roles');
  const data = await res.json().catch(() => ({}));
  if (res.ok) rolesState.roles = data.roles;
  return res.ok;
}

// The Roles section on a person's record (employees.js): shown to whoever may manage roles.
async function loadEmployeeRoles(personId) {
  const host = document.getElementById('emp-roles');
  if (!host) return;
  if (!(state.moderation && (state.moderation.isSuperadmin || state.moderation.canManageRoles))) { host.closest('[data-emp-roles-section]')?.remove(); return; }
  if (!(await loadRolesList())) { host.innerHTML = '<p class="pp-muted">Roles could not load.</p>'; return; }
  host.innerHTML = '<div id="emp-roles-box"></div>';
  showPersonRoles(personId, 'emp-roles-box');
}

async function loadRolesPanel() {
  const host = document.getElementById('moderation-roles');
  if (!host) return;
  host.innerHTML = '<div class="loading-state">Loading roles…</div>';
  try {
    const [rolesRes, permsRes, peopleRes] = await Promise.all([api('/api/roles'), api('/api/roles/permissions'), api('/api/people')]);
    const roles = await rolesRes.json();
    const perms = await permsRes.json();
    const people = await peopleRes.json();
    if (!rolesRes.ok) throw new Error(roles.error || 'Could not load roles');
    rolesState.roles = roles.roles;
    rolesState.permissions = perms.permissions || [];
    rolesState.people = (people.people || []).slice().sort((a, b) => personName(a).localeCompare(personName(b), undefined, { sensitivity: 'base' }));
    rolesState.loaded = true;
    renderRolesPanel();
    if (typeof loadRoleMentions === 'function') loadRoleMentions(); // the @ picker follows the role list
  } catch (err) {
    console.error('Load roles error:', err);
    host.innerHTML = emptyRecordMarkup('Roles could not load', err.message || 'Try again.');
  }
}

function closeRoleModal() {
  document.getElementById('role-modal-overlay')?.remove();
}

function openRoleEditor(roleId) {
  const role = roleId ? rolesState.roles.find((r) => r.id === roleId) : null;
  const editable = !role || role.builtin !== 'owner';
  const checks = rolesState.permissions.map((perm) => `
    <label class="role-perm"><input type="checkbox" name="perm" value="${escapeHtml(perm.key)}"${role && role.permissions.includes(perm.key) ? ' checked' : ''}>
      <span><strong>${escapeHtml(perm.label)}</strong><small>${escapeHtml(perm.key)}</small></span></label>`).join('');
  const overlay = document.createElement('div');
  overlay.id = 'role-modal-overlay';
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <form class="modal open role-modal" role="dialog" aria-modal="true" aria-label="${role ? 'Edit role' : 'New role'}">
      <div class="modal-header"><h3>${role ? `Edit ${escapeHtml(role.name)}` : 'New role'}</h3>
        <button class="modal-close" type="button" data-role-close aria-label="Close">&times;</button></div>
      <div class="modal-body">
        <div class="form-group"><label for="role-name">Name</label>
          <input id="role-name" type="text" maxlength="40" value="${escapeHtml(role ? role.name : '')}"${role && !role.canRename ? ' disabled' : ''} required></div>
        <div class="form-group"><label for="role-color">Color</label>
          <input id="role-color" type="color" value="${escapeHtml(role ? role.color : '#6B21A8')}"></div>
        <h4 class="modal-section-title">Permissions</h4>
        <div class="role-perms">${checks}</div>
        <p class="role-error" id="role-error" role="alert" hidden></p>
      </div>
      <div class="modal-footer">
        ${role && !role.builtin ? '<button type="button" class="btn danger" data-role-delete>Delete role</button>' : ''}
        <span class="photo-crop-spacer"></span>
        <button type="button" class="btn" data-role-close>Cancel</button>
        <button type="submit" class="btn primary">${role ? 'Save' : 'Create role'}</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#role-name').focus();
  const showError = (message) => { const box = overlay.querySelector('#role-error'); box.textContent = message; box.hidden = !message; };
  overlay.addEventListener('click', async (event) => {
    if (event.target === overlay || event.target.closest('[data-role-close]')) { closeRoleModal(); return; }
    if (event.target.closest('[data-role-delete]')) {
      const ok = await confirmAction({ title: `Delete ${role.name}?`, message: 'Everyone who holds it loses it, and any channel settings for it are removed.', confirmLabel: 'Delete role' });
      if (!ok) return;
      const res = await api(`/api/roles/${role.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data.error || 'Could not delete the role'); return; }
      closeRoleModal();
      showToast('Role deleted.', 'success');
      loadRolesPanel();
    }
  });
  overlay.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const body = {
      color: overlay.querySelector('#role-color').value,
      permissions: [...overlay.querySelectorAll('input[name="perm"]:checked')].map((box) => box.value),
    };
    if (!role || role.canRename) body.name = overlay.querySelector('#role-name').value;
    const res = await api(role ? `/api/roles/${role.id}` : '/api/roles', { method: role ? 'PUT' : 'POST', body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showError(data.error || 'Could not save the role'); return; }
    closeRoleModal();
    showToast(role ? 'Role saved.' : 'Role created.', 'success');
    loadRolesPanel();
  });
  if (!editable) overlay.querySelectorAll('input[name="perm"]').forEach((box) => { box.disabled = true; });
}

async function showPersonRoles(personId, boxId = 'role-assign-box') {
  const box = document.getElementById(boxId);
  if (!box) return;
  if (!personId) { box.innerHTML = ''; return; }
  const res = await api(`/api/roles/users/${personId}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { box.innerHTML = `<p class="role-error">${escapeHtml(data.error || 'Could not load their roles')}</p>`; return; }
  const held = new Set(data.roleIds);
  const custom = rolesState.roles.filter((r) => !r.builtin);
  box.innerHTML = custom.length ? `
    <div class="role-assign-list">${custom.map((r) => `
      <label class="role-perm"><input type="checkbox" name="assign" value="${r.id}"${held.has(r.id) ? ' checked' : ''}${r.canManage ? '' : ' disabled'}>
        <span>${roleDot(r)} <strong>${escapeHtml(r.name)}</strong></span></label>`).join('')}</div>
    <button type="button" class="btn primary" data-role-assign-save data-role-person-id="${personId}" data-box="${boxId}">Save roles</button>`
    : '<p class="moderation-help">Create a role first.</p>';
}

async function handleRolesClick(event) {
  const target = event.target;
  if (target.closest('[data-role-new]')) { openRoleEditor(null); return true; }
  const row = target.closest('.role-row');
  if (row && target.closest('[data-role-edit]')) { openRoleEditor(Number(row.dataset.roleId)); return true; }
  const move = row && target.closest('[data-role-move]');
  if (move) {
    const res = await api(`/api/roles/${row.dataset.roleId}/move`, { method: 'PUT', body: JSON.stringify({ direction: move.dataset.roleMove }) });
    if (!res.ok) showToast((await res.json().catch(() => ({}))).error || 'Could not move the role.', 'error');
    loadRolesPanel();
    return true;
  }
  if (target.closest('[data-access-check]')) { runAccessCheck(); return true; }
  const viewAs = target.closest('[data-view-as]');
  if (viewAs) { startViewAs(viewAs.dataset.viewAs); return true; }
  const save = target.closest('[data-role-assign-save]');
  if (save) {
    const roleIds = [...document.querySelectorAll(`#${save.dataset.box || 'role-assign-box'} input[name="assign"]:checked`)].map((box) => Number(box.value));
    const res = await api(`/api/roles/users/${save.dataset.rolePersonId}`, { method: 'PUT', body: JSON.stringify({ roleIds }) });
    const data = await res.json().catch(() => ({}));
    showToast(res.ok ? 'Roles saved.' : (data.error || 'Could not save the roles.'), res.ok ? 'success' : 'error');
    if (res.ok) { await loadRolesList(); showPersonRoles(save.dataset.rolePersonId, save.dataset.box || 'emp-roles-box'); }
    return true;
  }
  return false;
}

if (typeof document !== 'undefined') {
  document.addEventListener('change', (event) => {
    const box = event.target && event.target.closest ? event.target.closest('input[data-role-toggle]') : null;
    if (box) toggleRoleFor(box.closest('tr'), box);
  });
  document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'access-subject') runAccessCheck();
  });
  document.addEventListener('input', (event) => {
    if (event.target && event.target.id === 'role-table-search') { roleTable.query = event.target.value; renderRoleTable(); }
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest && event.target.closest('#moderation-roles')) handleRolesClick(event);
  });
}
