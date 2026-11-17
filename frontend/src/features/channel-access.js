// Phase 2D: administrative channel-access controls; independent of action permissions.
const channelAccessUi = { channelId: null, people: [], departments: [], policy: null };
const channelAccessEscape = (value) => escapeHtml(String(value ?? ''));
async function channelAccessRequest(url, method = 'GET', body) {
  const response = await api(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Request failed (${response.status})`);
  return json;
}
async function loadChannelAccessCard(channelId) {
  const host = document.getElementById('moderation-channel-access');
  if (!host) return;
  channelAccessUi.channelId = Number(channelId);
  host.innerHTML = '<div class="moderation-card">Loading channel access…</div>';
  try {
    const [policy, departments, people] = await Promise.all([
      channelAccessRequest(`/api/channels/${channelId}/access-policy`),
      channelAccessRequest('/api/hr/departments'),
      channelAccessRequest('/api/users'),
    ]);
    if (channelAccessUi.channelId !== Number(channelId)) return;
    channelAccessUi.policy = policy;
    channelAccessUi.departments = departments.departments || [];
    channelAccessUi.people = (Array.isArray(people) ? people : people.users || []).filter((u) => u.accountType !== 'guest' && !u.deactivatedAt);
    renderChannelAccessCard();
    await loadChannelLifecycleControls(channelId);
  } catch (err) {
    host.innerHTML = `<div class="moderation-card"><p>${channelAccessEscape(err.message)}</p><button class="btn" type="button" data-access-refresh>Retry</button></div>`;
  }
}
function accessPersonName(id) {
  const u = channelAccessUi.people.find(p => Number(p.id) === Number(id));
  return u ? (u.username || u.name || `Employee #${id}`) : `Employee #${id}`;
}
function renderChannelAccessCard() {
  const host = document.getElementById('moderation-channel-access');
  if (!host || !channelAccessUi.policy) return;
  const p = channelAccessUi.policy;
  const checked = new Set((p.departmentIds || []).map(Number));
  const options = channelAccessUi.people.map(u => `<option value="${Number(u.id)}">${channelAccessEscape(u.username || u.name || u.id)}</option>`).join('');
  host.innerHTML = `<div class="moderation-card"><h2>Channel access</h2>
    <p class="moderation-help">Access controls who can enter and read this channel; Permissions controls what they can do. New access can reveal all retained history. Bans override all access grants.</p>
    <h3>Departments</h3><div class="moderation-list">${channelAccessUi.departments.map(d => `<label class="preference-toggle"><input type="checkbox" data-access-dept="${Number(d.id)}" ${checked.has(Number(d.id)) ? 'checked' : ''}><span>${channelAccessEscape(d.name)}</span></label>`).join('') || '<p>No departments available.</p>'}</div>
    <button class="btn primary" type="button" data-access-save-depts>Save department access…</button>
    <h3>Direct invitations</h3><p class="form-note">Blank expiration means permanent access.</p>
    <div class="moderation-inline"><select id="access-invite-user" aria-label="Invite employee">${options}</select><input type="datetime-local" id="access-invite-expiry" aria-label="Invitation expiration"><button class="btn" type="button" data-access-invite>Invite…</button></div>
    <div class="moderation-list">${(p.invitations || []).map(i => `<div class="moderation-row"><span>${channelAccessEscape(accessPersonName(i.user_id))}<small>${i.expires_at ? 'Until '+channelAccessEscape(new Date(i.expires_at).toLocaleString()) : 'Permanent'}</small></span><button type="button" class="btn danger-outline" data-access-revoke="${Number(i.user_id)}">Revoke</button></div>`).join('') || '<p>No direct invitations.</p>'}</div>
    <h3>Channel bans</h3><div class="moderation-inline"><select id="access-ban-user" aria-label="Employee to ban">${options}</select><input id="access-ban-reason" maxlength="500" placeholder="Reason (required)" aria-label="Ban reason"><button type="button" class="btn danger" data-access-ban>Ban…</button></div>
    <div class="moderation-list">${(p.bans || []).map(b => `<div class="moderation-row"><span>${channelAccessEscape(accessPersonName(b.user_id))}<small>${channelAccessEscape(b.reason)}</small></span><button type="button" class="btn" data-access-unban="${Number(b.user_id)}">Unban</button></div>`).join('') || '<p>No banned users.</p>'}</div>
    <p class="form-note" id="channel-access-feedback" aria-live="polite"></p></div>`;
}
async function channelAccessMutate(action) {
  try {
    await action();
    showToast('Channel access updated.', 'success');
    await loadChannelAccessCard(channelAccessUi.channelId);
  } catch(err) { showToast(err.message || 'Could not update channel access', 'error'); }
}
async function loadEmployeeDepartments(userId) {
  const host = document.getElementById('emp-multi-departments');
  if (!host) return;
  try {
    const data = await channelAccessRequest(`/api/organization/users/${userId}/departments`);
    if (!host.isConnected || Number(employeeState.editingId) !== Number(userId)) return;
    const departments = employeeState.departments || [];
    const assigned = new Set((data.departments || []).map(d => Number(d.department_id)));
    const primary = (data.departments || []).find(d => d.is_primary)?.department_id ?? '';
    host.innerHTML = `<h4 class="modal-section-title">Department memberships</h4><p class="form-note">Multiple departments can grant channel access. Save separately from the employee record. Changing memberships may add or revoke access to channel history.</p>
    ${departments.map(d => `<label class="preference-toggle"><input type="checkbox" data-emp-extra-dept="${Number(d.id)}" ${assigned.has(Number(d.id))?'checked':''}><span>${channelAccessEscape(d.name)}</span></label>`).join('')}
    <label>Primary department<select id="emp-primary-department"><option value="">None</option>${departments.map(d => `<option value="${Number(d.id)}" ${Number(primary)===Number(d.id)?'selected':''}>${channelAccessEscape(d.name)}</option>`).join('')}</select></label>
    <button class="btn" type="button" data-emp-save-departments="${Number(userId)}">Save memberships…</button>`;
  } catch(err) { host.textContent = `Department memberships unavailable: ${err.message}`; }
}
if (typeof document !== 'undefined') document.addEventListener('click', async (event) => {
  const node = event.target.closest('[data-access-refresh], [data-access-save-depts], [data-access-invite], [data-access-revoke], [data-access-ban], [data-access-unban], [data-emp-save-departments]');
  if (!node) return;
  event.preventDefault();
  if (node.hasAttribute('data-emp-save-departments')) {
    const id = Number(node.dataset.empSaveDepartments);
    const departmentIds = [...document.querySelectorAll('#emp-multi-departments [data-emp-extra-dept]:checked')].map(n => Number(n.dataset.empExtraDept));
    const primary = document.getElementById('emp-primary-department')?.value;
    if ((primary && !departmentIds.includes(Number(primary))) || (!primary && departmentIds.length)) { showToast('Choose a primary department from the checked memberships.', 'error'); return; }
    if (!(await confirmAction({ title: 'Change access', message: 'Change this employee’s department-based channel access? This may expose full retained channel history or revoke existing access.', confirmLabel: 'Change access' }))) return;
    await channelAccessMutate(() => channelAccessRequest(`/api/organization/users/${id}/departments`, 'PUT', { departmentIds, primaryDepartmentId: primary ? Number(primary) : null, confirmAccessChanges: true }));
    await loadEmployeeDepartments(id);
    return;
  }
  const id = channelAccessUi.channelId;
  if (!id) return;
  if (node.hasAttribute('data-access-refresh')) { await loadChannelAccessCard(id); return; }
  if (node.hasAttribute('data-access-save-depts')) {
    const departmentIds = [...document.querySelectorAll('#moderation-channel-access [data-access-dept]:checked')].map(n => Number(n.dataset.accessDept));
    if (!(await confirmAction({ title: 'Change access', message: 'Change channel department access? Newly authorized employees can read full retained history.', confirmLabel: 'Change access' }))) return;
    await channelAccessMutate(() => channelAccessRequest(`/api/channels/${id}/access-policy/departments`, 'PUT', { departmentIds, confirmHistoryExposure:true }));
  } else if (node.hasAttribute('data-access-invite')) {
    const userId = Number(document.getElementById('access-invite-user')?.value);
    const raw = document.getElementById('access-invite-expiry')?.value;
    if (!userId) return;
    if (!(await confirmAction({ title: 'Invite', message: 'Invite this employee? They may read all retained channel history.', confirmLabel: 'Invite', danger: false }))) return;
    await channelAccessMutate(() => channelAccessRequest(`/api/channels/${id}/access-policy/invitation`, 'PUT', { userId, expiresAt:raw ? new Date(raw).toISOString() : null, confirmHistoryExposure:true }));
  } else if (node.hasAttribute('data-access-revoke')) {
    if (!(await confirmAction({ title: 'Revoke', message: 'Revoke this direct invitation? Other grants may still allow access.', confirmLabel: 'Revoke' }))) return;
    await channelAccessMutate(() => channelAccessRequest(`/api/channels/${id}/access-policy/invitation/${Number(node.dataset.accessRevoke)}`, 'DELETE'));
  } else if (node.hasAttribute('data-access-ban')) {
    const userId = Number(document.getElementById('access-ban-user')?.value);
    const reason = document.getElementById('access-ban-reason')?.value.trim();
    if (!userId || !reason) { showToast('Select an employee and enter a reason.', 'error'); return; }
    if (!(await confirmAction({ title: 'Ban', message: 'Ban this employee from the channel, overriding every access grant?', confirmLabel: 'Ban' }))) return;
    await channelAccessMutate(() => channelAccessRequest(`/api/channels/${id}/access-policy/ban`, 'PUT', {userId, reason}));
  } else if (node.hasAttribute('data-access-unban')) {
    if (!(await confirmAction({ title: 'Remove ban', message: 'Remove this channel ban? Other access grants may become effective again.', confirmLabel: 'Remove ban' }))) return;
    await channelAccessMutate(() => channelAccessRequest(`/api/channels/${id}/access-policy/ban/${Number(node.dataset.accessUnban)}`, 'DELETE'));
  }
});

// Phase 4 channel lifecycle controls. Administrative metadata access is separate
// from channel-content access. All destructive actions are confirmed server-side.
async function loadChannelLifecycleControls(channelId) {
  const host = document.getElementById('moderation-channel-access');
  if (!host || channelAccessUi.channelId !== Number(channelId)) return;
  try {
    const info = await channelAccessRequest(`/api/moderation/channels/${channelId}/managers`);
    if (channelAccessUi.channelId !== Number(channelId)) return;
    const opts = channelAccessUi.people.map(u => `<option value="${Number(u.id)}">${channelAccessEscape(u.username || u.name || u.id)}</option>`).join('');
    const roster = (info.managers || []).map(u => `<li>${channelAccessEscape([u.first_name,u.last_name].filter(Boolean).join(' ') || u.username)}</li>`).join('');
    host.insertAdjacentHTML('beforeend', `<section class="moderation-card" id="channel-lifecycle-controls">
      <h2>Channel management</h2><p class="moderation-help">Managers must already be members of this channel. Assigning a manager does not grant new channel access.</p>
      <h3>Current managers</h3><ul>${roster || '<li>No active managers — recovery required</li>'}</ul>
      <label>Manager assignment (select one or more)<select id="channel-manager-list" multiple size="5">${opts}</select></label>
      <button class="btn" type="button" data-channel-replace-managers="${Number(channelId)}">Save managers…</button>
      <h3>Archive and recovery</h3><p>Archived channels preserve their content and cannot accept new messages.</p>
      ${info.archivedAt ? `<button class="btn" type="button" data-channel-restore="${Number(channelId)}">Restore channel…</button><button class="btn danger" type="button" data-channel-permanent-delete="${Number(channelId)}">Permanently delete…</button>`
       : `<button class="btn danger-outline" type="button" data-channel-archive="${Number(channelId)}">Archive channel…</button>`}</section>`);
    const current = new Set((info.managers || []).map(u => Number(u.id)));
    host.querySelectorAll('#channel-manager-list option').forEach(o => {o.selected=current.has(Number(o.value));});
  } catch (err) {
    // Not everyone with channel access is a workspace management administrator.
    if (err.message && /403|denied|superadmin|permission/i.test(err.message)) return;
    host.insertAdjacentHTML('beforeend', `<p class="form-note">Channel management unavailable: ${channelAccessEscape(err.message)}</p>`);
  }
}
if (typeof document !== 'undefined') document.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-channel-replace-managers],[data-channel-archive],[data-channel-restore],[data-channel-permanent-delete]');
  if (!control) return;
  const channelId = Number(control.dataset.channelReplaceManagers || control.dataset.channelArchive || control.dataset.channelRestore || control.dataset.channelPermanentDelete);
  let path, method = 'POST', body;
  if (control.hasAttribute('data-channel-replace-managers')) {
    const managerIds = [...document.querySelectorAll('#channel-manager-list option:checked')].map(n=>Number(n.value));
    if (!managerIds.length) { showToast('A channel must have at least one manager.', 'error'); return; }
    path=`/api/moderation/channels/${channelId}/managers`; method='PUT'; body={managerIds,confirmation:'UPDATE CHANNEL MANAGERS'};
  } else if (control.hasAttribute('data-channel-archive')) {
    path=`/api/moderation/channels/${channelId}/archive`; body={confirmation:'ARCHIVE CHANNEL'};
  } else if (control.hasAttribute('data-channel-restore')) {
    path=`/api/moderation/channels/${channelId}/restore`; body={confirmation:'RESTORE CHANNEL'};
  } else {
    path=`/api/moderation/channels/${channelId}`;method='DELETE';body={confirmation:'PERMANENTLY DELETE CHANNEL'};
  }
  if (!(await confirmAction({ title: method === 'DELETE' ? 'Delete channel' : 'Confirm', message: `Confirm ${method === 'DELETE' ? 'PERMANENT deletion of this channel and all its content' : 'this channel management change'}?`, confirmLabel: method === 'DELETE' ? 'Delete channel' : 'Confirm' }))) return;
  control.disabled=true;
  try { await channelAccessRequest(path,method,body); showToast('Channel management updated.', 'success'); if(method==='DELETE') { control.closest('#channel-lifecycle-controls')?.remove(); } else { await loadChannelAccessCard(channelId); } }
  catch(err){ showToast(err.message || 'Could not update channel', 'error'); }
  finally {control.disabled=false;}
});
