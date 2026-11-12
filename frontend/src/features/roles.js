// IT Avenue Workspace - the Roles panel in Moderation (docs/ROLES_DESIGN.md, phase 2).
//
// Lists the workspace's roles in rank order (highest first), creates and edits them with a permission checklist, moves
// custom roles up and down, and gives custom roles to people. Owner and HR are built in: they are given with the
// Superadmin and HR switches on a person's record. The server enforces the rules; this only shows what is allowed.

const rolesState = { roles: [], permissions: [], people: [], loaded: false };

function roleDot(role) {
  return `<span class="role-dot" style="background:${escapeHtml(role.color)}"></span>`;
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
        <small>${escapeHtml(roleSummary(role))} · ${role.memberCount} ${role.memberCount === 1 ? 'person' : 'people'}</small></div>
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
      <h2>Give roles to a person</h2>
      <p class="moderation-help">Owner and HR are set on the person's record (Superadmin and HR switches). Pick a person to choose their other roles.</p>
      <div class="role-assign"><select id="role-assign-person" aria-label="Person"><option value="">Choose a person…</option>${rolesState.people.map((p) => `<option value="${p.id}">${escapeHtml(personName(p))}</option>`).join('')}</select></div>
      <div id="role-assign-box"></div>
    </div>`;
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
    <button type="button" class="btn primary" data-role-assign-save data-person="${personId}" data-box="${boxId}">Save roles</button>`
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
  const save = target.closest('[data-role-assign-save]');
  if (save) {
    const roleIds = [...document.querySelectorAll(`#${save.dataset.box || 'role-assign-box'} input[name="assign"]:checked`)].map((box) => Number(box.value));
    const res = await api(`/api/roles/users/${save.dataset.person}`, { method: 'PUT', body: JSON.stringify({ roleIds }) });
    const data = await res.json().catch(() => ({}));
    showToast(res.ok ? 'Roles saved.' : (data.error || 'Could not save the roles.'), res.ok ? 'success' : 'error');
    if (res.ok && save.dataset.box === 'emp-roles-box') { await loadRolesList(); showPersonRoles(save.dataset.person, 'emp-roles-box'); }
    else if (res.ok) loadRolesPanel().then(() => { const select = document.getElementById('role-assign-person'); if (select) { select.value = save.dataset.person; showPersonRoles(save.dataset.person); } });
    return true;
  }
  return false;
}

if (typeof document !== 'undefined') {
  document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'role-assign-person') showPersonRoles(event.target.value);
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest && event.target.closest('#moderation-roles')) handleRolesClick(event);
  });
}
