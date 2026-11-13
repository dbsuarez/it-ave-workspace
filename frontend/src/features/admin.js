// IT Avenue Workspace - guest accounts, invitations, and workspace member
// administration (Superadmin section of the Moderation view).
//
// Loaded before renderer.js; defines functions only.

function adminState() {
  if (!state.admin) state.admin = { users: [], invitations: [], mode: 'open', lastCode: null, lastCreated: null, bulkText: '', importNotes: [], pending: [], prelaunch: { enabled: false, password: '' } };
  return state.admin;
}

function isGuestAccount() {
  return state.moderation?.accountType === 'guest';
}

// Hides what a guest cannot use. The server enforces the same rules.
function applyAccountRestrictions() {
  document.body.classList.toggle('account-guest', isGuestAccount());
  const tag = document.getElementById('user-account-type');
  if (tag) tag.hidden = !isGuestAccount();
}

async function handleAccountUpdated() {
  await loadModerationAccess();
  await Promise.all([loadChannels(), loadUsers()]);
  showToast(isGuestAccount()
    ? 'Your account is now a guest account. You can only use the channels you were added to.'
    : 'Your account role was updated.');
}

async function adminApi(path, method = 'GET', body) {
  const res = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadWorkspaceAdmin() {
  const host = document.getElementById('moderation-content');
  if (!host || !state.moderation.isSuperadmin) return;
  let section = document.getElementById('admin-workspace');
  if (!section) {
    section = document.createElement('div');
    section.id = 'admin-workspace';
    section.className = 'admin-workspace';
    host.appendChild(section);
  }
  section.hidden = false;
  document.querySelectorAll('[data-admin-tab-content="people"] > [data-admin-control-panel], [data-admin-tab-content="signup"] > [data-admin-control-panel]').forEach((panel) => panel.remove());
  section.innerHTML = '<div class="loading-state">Loading workspace administration…</div>';
  const admin = adminState();
  try {
    const [users, invitations, registration, prelaunch] = await Promise.all([
      adminApi('/api/admin/users'),
      adminApi('/api/admin/invitations'),
      adminApi('/api/admin/registration'),
      adminApi('/api/admin/prelaunch'),
    ]);
    admin.prelaunch = prelaunch;
    admin.users = users.users || [];
    admin.invitations = invitations.invitations || [];
    admin.mode = registration.mode || 'open';
    renderWorkspaceAdmin();
  } catch (err) {
    console.error('Load workspace administration error:', err);
    section.innerHTML = `<div class="moderation-card"><h2>Workspace administration</h2><p>${escapeHtml(err.message || 'Could not load.')}</p></div>`;
  }
}

function invitationStatusLabel(invitation) {
  if (invitation.status === 'used') return `Used by ${invitation.usedBy || 'a former user'}`;
  if (invitation.status === 'revoked') return 'Revoked';
  if (invitation.status === 'expired') return 'Expired';
  return `Pending · expires ${new Date(invitation.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

// What came back from creating accounts: the passwords (shown once) and the rows that were skipped, with why.
function adminCreatedHtml(result) {
  if (!result) return '';
  const made = result.created.length;
  return `<div class="admin-created">
    ${made ? `<h3>${made} account${made === 1 ? '' : 's'} created</h3>
      <p class="admin-help">These temporary passwords are shown only now. Save or copy them before you leave this page.</p>
      <table class="admin-table"><thead><tr><th>Username</th><th>Email</th><th>Temporary password</th></tr></thead><tbody>
        ${result.created.map((c) => `<tr><td>${escapeHtml(c.username)}</td><td>${escapeHtml(c.email)}</td><td><code>${escapeHtml(c.password)}</code></td></tr>`).join('')}
      </tbody></table>
      <div class="admin-actions"><button class="btn" type="button" data-admin-action="save-credentials">Save as CSV…</button><button class="btn" type="button" data-admin-action="copy-credentials">Copy all</button></div>` : '<h3>No accounts were created</h3>'}
    ${result.createdDepartments && result.createdDepartments.length ? `<p class="admin-note">New department${result.createdDepartments.length === 1 ? '' : 's'} created from the list: ${result.createdDepartments.map(escapeHtml).join(', ')}. Check the spelling in People > Manage > Departments.</p>` : ''}
    ${result.warnings && result.warnings.length ? `<h3>${result.warnings.length} to check</h3><ul class="admin-skipped">${result.warnings.map((w) => `<li><strong>${escapeHtml(w.username)}</strong>: ${escapeHtml(w.warning)}</li>`).join('')}</ul>` : ''}
    ${result.skipped.length ? `<h3>${result.skipped.length} skipped</h3><ul class="admin-skipped">${result.skipped.map((s) => `<li><strong>${escapeHtml(s.username)}</strong>: ${escapeHtml(s.reason)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

// The people read from a file, waiting to be created: a short preview with the fields that matter.
function adminPendingHtml(admin) {
  const list = admin.pending || [];
  if (!list.length) return '';
  const shown = list.slice(0, 8);
  const level = (a) => (a.jobLevel ? (/manag/i.test(a.jobLevel) ? 'Managerial' : 'Rank and file') : '');
  return `<div class="admin-pending">
    <h3>${list.length} ${list.length === 1 ? 'person' : 'people'} ready from the file</h3>
    <table class="admin-table"><thead><tr><th>Username</th><th>Name</th><th>Employee no.</th><th>Department</th><th>Job title</th><th>Level</th><th>Reports to</th></tr></thead><tbody>
      ${shown.map((a) => `<tr><td>${escapeHtml(a.username)}<br><small>${escapeHtml(a.email)}</small></td><td>${escapeHtml([a.firstName, a.middleName, a.lastName].filter(Boolean).join(' '))}</td><td>${escapeHtml(a.employeeNo || '')}</td><td>${escapeHtml(a.department || '')}</td><td>${escapeHtml(a.jobTitle || '')}</td><td>${escapeHtml(level(a))}</td><td>${escapeHtml(a.reportsTo || '')}</td></tr>`).join('')}
    </tbody></table>
    ${list.length > shown.length ? `<p class="admin-help">…and ${list.length - shown.length} more.</p>` : ''}
    <div class="admin-actions"><button class="btn" type="button" data-admin-action="clear-pending">Clear this list</button></div>
  </div>`;
}

// The lines of the box, as accounts. A line with a tab is split on tabs (so a password may hold commas);
// otherwise on a comma or semicolon.
function parseBulkLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = (line.includes('\t') ? line.split('\t') : line.split(/[,;]/)).map((part) => part.trim());
    const account = { username: parts[0] || '', email: parts[1] || '', password: parts[2] || '' };
    if (parts[3]) account.lastName = parts[3];
    if (parts[4]) account.firstName = parts[4];
    if (parts[5]) account.middleName = parts[5];
    return account;
  });
}

function bulkLine(account) {
  const fields = [account.username, account.email, account.password || '', account.lastName || '', account.firstName || '', account.middleName || ''];
  while (fields.length > 2 && !fields[fields.length - 1]) fields.pop();
  return fields.some((value) => value.includes(',')) ? fields.join('\t') : fields.join(', ');
}

// The "Create accounts" form. Used in Moderation (Superadmin) and in People > Manage (HR, who may add members only).
function accountsFormHtml(admin, superadmin) {
  return `
    <form class="moderation-card" data-admin-form="accounts">
      <h2>Create accounts</h2>
      <p class="admin-help">Create people's accounts yourself instead of sending each one an invitation. Each person signs in with a temporary password and is asked to choose their own.</p>
      <div class="moderation-inline">
        <label>Account type
          <select name="accountType">
            <option value="member">Member (all public channels)</option>
            ${superadmin ? '<option value="guest">Guest (only the channels below)</option>' : ''}
          </select>
        </label>
      </div>
      ${adminPendingHtml(admin)}
      <label class="admin-bulk-label">${admin.pending && admin.pending.length ? 'Add more people by hand' : 'Type or paste people'}, one per line: <code>username, email, password, last name, first name, middle name</code>. Only the username and email are needed; leave the password empty and one is made for you (for example <code>ann, ann@company.com, , Lee, Ann, Marie</code>). For everything else about an employee (employee number, department, job title, position level, hire date, who they report to...), use <strong>Import</strong> with the template.
        <textarea name="bulk" id="admin-bulk" rows="6" spellcheck="false" placeholder="ann, ann@company.com&#10;bob, bob@company.com">${escapeHtml(admin.bulkText || '')}</textarea>
      </label>
      <div class="admin-channel-picks">
        ${state.channels.map((channel) => `<label class="admin-inline-check"><input type="checkbox" name="channelIds" value="${channel.id}"> #${escapeHtml(channel.name)}</label>`).join('')}
      </div>
      <p class="admin-help">Members are added to every public channel; tick channels to add them to private ones too. Guests need at least one.</p>
      ${(admin.importNotes || []).map((note) => `<p class="admin-note">${escapeHtml(note)}</p>`).join('')}
      <div class="admin-actions">
        <button class="btn" type="button" data-admin-action="import-accounts">Import CSV or Excel file…</button>
        <button class="btn" type="button" data-admin-action="accounts-template">Download template (all fields)</button>
        <button class="btn primary" type="submit">Create accounts</button>
      </div>
      ${adminCreatedHtml(admin.lastCreated)}
    </form>`;
}

// Draw the form again wherever it is on screen (its box text and the result of the last run live in adminState()).
function refreshAccountsForms() {
  const admin = adminState();
  document.querySelectorAll('[data-accounts-host]').forEach((host) => {
    host.innerHTML = accountsFormHtml(admin, Boolean(state.moderation && state.moderation.isSuperadmin));
  });
}

function renderWorkspaceAdmin() {
  const section = document.getElementById('admin-workspace');
  if (!section) return;
  const admin = adminState();
  const channelName = (id) => state.channels.find((channel) => Number(channel.id) === Number(id))?.name || `channel ${id}`;
  const channelContext = state.moderation.peopleChannelId
    ? state.channels.find((channel) => Number(channel.id) === Number(state.moderation.peopleChannelId))
    : null;
  const channelMembers = new Map((state.moderation.channelMembers || []).map((member) => [Number(member.id), member]));

  const userRows = admin.users.map((user) => {
    const self = Number(user.id) === Number(state.user.id);
    const channelMember = channelContext ? channelMembers.get(Number(user.id)) : null;
    const channelAccess = channelContext ? `
      <div class="admin-channel-access">
        <span class="channel-access-state${channelMember ? ' has-access' : ''}">${channelMember ? 'Has access' : 'No access'}</span>
        <select data-member-role="${user.id}" aria-label="Channel role for ${escapeHtml(user.username)}">
          <option value="member"${!channelMember || channelMember.role === 'member' ? ' selected' : ''}>Member</option>
          <option value="moderator"${channelMember?.role === 'moderator' ? ' selected' : ''}>Moderator</option>
        </select>
        <button class="btn" type="button" data-action="save-role" data-member-id="${user.id}">${channelMember ? 'Save role' : 'Add access'}</button>
        ${channelMember ? `<button class="btn" type="button" data-action="timeout" data-member-id="${user.id}">Timeout</button>` : ''}
        ${channelMember && !channelContext.availableToAll ? `<button class="btn danger-outline" type="button" data-action="remove-member" data-member-id="${user.id}">Remove access</button>` : ''}
        ${channelMember && channelContext.availableToAll ? '<span class="form-note">Required for everyone</span>' : ''}
      </div>` : '';
    return `
      <div class="moderation-row admin-user-row" data-admin-user="${user.id}">
        <span><strong>${escapeHtml(user.username)}</strong>${self ? ' (you)' : ''}<br><small>${escapeHtml(user.email)} · ${user.channelCount} channel${user.channelCount === 1 ? '' : 's'}${user.moderatorChannelCount ? ` · moderator in ${user.moderatorChannelCount}` : ''}</small></span>
        <div class="moderation-row-actions">
          <select data-admin-type aria-label="Account type for ${escapeHtml(user.username)}"${self ? ' disabled' : ''}>
            <option value="member"${user.accountType === 'member' ? ' selected' : ''}>Member</option>
            <option value="guest"${user.accountType === 'guest' ? ' selected' : ''}>Guest</option>
          </select>
          <label class="admin-inline-check"><input type="checkbox" data-admin-superadmin${user.isSuperadmin ? ' checked' : ''}${self ? ' disabled' : ''}> Superadmin</label>
          ${user.accountType === 'member' ? `<label class="admin-inline-check" title="HR can manage employee records, departments and reporting lines"><input type="checkbox" data-admin-hr${user.isHr ? ' checked' : ''}> HR</label>` : ''}
          <button class="btn" type="button" data-admin-action="save-user"${self ? ' disabled' : ''}>Save</button>
        </div>
        ${channelAccess}
      </div>`;
  }).join('');

  const invitationRows = admin.invitations.map((invitation) => `
    <div class="moderation-row">
      <span><strong>${invitation.accountType === 'guest' ? 'Guest' : 'Member'}</strong>${invitation.note ? ` · ${escapeHtml(invitation.note)}` : ''}<br>
        <small>${escapeHtml(invitationStatusLabel(invitation))}${invitation.channelIds.length ? ` · ${invitation.channelIds.map((id) => `#${escapeHtml(channelName(id))}`).join(', ')}` : ''}</small></span>
      <div class="moderation-row-actions">
        ${invitation.status === 'pending' ? `<button class="btn" type="button" data-admin-action="revoke-invitation" data-invitation-id="${invitation.id}">Revoke</button>` : ''}
      </div>
    </div>`).join('');

  section.innerHTML = `
    <div class="moderation-card${admin.prelaunch.enabled ? ' prelaunch-on' : ''}" id="admin-prelaunch-access" data-mod-tab="signup">
      <h2>Before go-live: shared test password</h2>
      <p class="admin-help">While you are testing, every employee can use one known password. It does not apply to Superadmins, guests or deactivated accounts. <strong>Turn it off and go live before real use</strong>: anyone who knows the password can sign in as any employee.</p>
      <p><strong>${admin.prelaunch.enabled ? 'On' : 'Off'}</strong>${admin.prelaunch.enabled ? ` · password <code class="emp-password">${escapeHtml(admin.prelaunch.password)}</code>. New accounts get it and are not asked to change it.` : '. New accounts get a random temporary password and must choose their own.'}</p>
      <div class="admin-actions">
        ${admin.prelaunch.enabled
    ? `<button class="btn primary" type="button" data-admin-action="prelaunch-apply">Give every employee the test password now</button>
           <button class="btn danger" type="button" data-admin-action="prelaunch-golive">Go live: everyone must choose a new password…</button>
           <button class="btn" type="button" data-admin-action="prelaunch-off">Switch off</button>`
    : '<button class="btn" type="button" data-admin-action="prelaunch-on">Switch on</button>'}
      </div>
    </div>
    <div class="moderation-card" id="admin-registration" data-mod-tab="signup">
      <h2>Sign-up</h2>
      <div class="moderation-inline">
        <label>Who can create an account
          <select id="admin-registration-mode">
            <option value="open"${admin.mode === 'open' ? ' selected' : ''}>Anyone who can reach this server</option>
            <option value="invite"${admin.mode === 'invite' ? ' selected' : ''}>Only people with an invitation code</option>
          </select>
        </label>
        <button class="btn" type="button" data-admin-action="save-registration">Save</button>
      </div>
    </div>
    <div id="admin-create-accounts" data-accounts-host data-mod-tab="people">${accountsFormHtml(admin, true)}</div>
    <form class="moderation-card" id="admin-invite-form" data-admin-form="invitation" data-mod-tab="signup">
      <h2>Invite someone</h2>
      <div class="moderation-inline">
        <label>Account type
          <select name="accountType">
            <option value="member">Member (all public channels)</option>
            <option value="guest">Guest (only the channels below)</option>
          </select>
        </label>
        <label>Expires after
          <select name="expiresInHours">
            <option value="24">1 day</option>
            <option value="72" selected>3 days</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </select>
        </label>
        <label>Note (optional)<input name="note" type="text" maxlength="120" placeholder="Who is this for?"></label>
      </div>
      <div class="admin-channel-picks">
        ${state.channels.map((channel) => `<label class="admin-inline-check"><input type="checkbox" name="channelIds" value="${channel.id}"> #${escapeHtml(channel.name)}</label>`).join('')}
      </div>
      <button class="btn primary" type="submit">Create invitation code</button>
      ${admin.lastCode ? `<p class="admin-invite-code">New code: <code id="admin-last-code">${escapeHtml(admin.lastCode)}</code> <button class="btn" type="button" data-admin-action="copy-code">Copy</button><br><small>Share it now. It is shown only once and works for one sign-up.</small></p>` : ''}
    </form>
    <div class="moderation-card" id="admin-invitations" data-mod-tab="signup"><h2>Invitations</h2><div class="moderation-list">${invitationRows || '<p>No invitations yet.</p>'}</div></div>
    <div class="moderation-card" id="admin-workspace-members" data-mod-tab="people">
      <div class="workspace-members-head"><div><h2>Workspace members</h2>${channelContext ? `<p class="admin-help">Managing explicit access to <strong>#${escapeHtml(channelContext.name)}</strong>. Workspace roles and channel permissions may also grant access.</p>` : '<p class="admin-help">Manage workspace accounts and roles from one directory.</p>'}</div>
        ${channelContext ? '<button class="btn" type="button" data-action="close-channel-people">Show all workspace members</button>' : ''}</div>
      <input class="workspace-member-search" type="search" placeholder="Search workspace members..." aria-label="Search workspace members" data-workspace-member-search>
      <div class="moderation-list" data-workspace-member-list>${userRows}</div>
    </div>`;
  const panelKeys = {
    'admin-create-accounts': 'accounts',
    'admin-workspace-members': 'members',
    'admin-prelaunch-access': 'prelaunch',
    'admin-registration': 'registration',
    'admin-invite-form': 'invite',
    'admin-invitations': 'invitations',
  };
  section.querySelectorAll(':scope > [data-mod-tab]').forEach((panel) => {
    const tab = panel.dataset.modTab;
    const target = document.querySelector(`[data-admin-tab-content="${tab}"]`);
    if (!target || !panelKeys[panel.id]) return;
    panel.dataset.adminControlPanel = panelKeys[panel.id];
    panel.removeAttribute('data-mod-tab');
    target.appendChild(panel);
  });
  syncAdminConfigurator('people');
  syncAdminConfigurator('signup');
  section.hidden = true;
}

async function handleAdminClick(event) {
  const button = event.target.closest('[data-admin-action]');
  if (!button) return;
  const admin = adminState();
  const action = button.dataset.adminAction;
  try {
    if (action === 'save-registration') {
      const mode = document.getElementById('admin-registration-mode').value;
      await adminApi('/api/admin/registration', 'PUT', { mode });
      admin.mode = mode;
      showToast(mode === 'invite' ? 'Sign-up now requires an invitation code.' : 'Sign-up is open.', 'success');
    } else if (action === 'revoke-invitation') {
      await adminApi(`/api/admin/invitations/${button.dataset.invitationId}`, 'DELETE');
      showToast('Invitation revoked.', 'success');
      await loadWorkspaceAdmin();
    } else if (action === 'prelaunch-on' || action === 'prelaunch-off') {
      await adminApi('/api/admin/prelaunch', 'PUT', { enabled: action === 'prelaunch-on' });
      showToast(action === 'prelaunch-on' ? 'Shared test password is on. Use "Give every employee…" to set it for existing employees.' : 'Shared test password is off. Existing passwords are unchanged.', 'success');
      await loadWorkspaceAdmin();
      return;
    } else if (action === 'prelaunch-apply') {
      if (!confirm('Set the shared test password for every employee now?\n\nThey are signed out and their current passwords stop working. Superadmins and guests are not changed.')) return;
      const data = await adminApi('/api/admin/prelaunch/apply', 'POST', {});
      showToast(`${data.changed} employee${data.changed === 1 ? '' : 's'} now use the test password.`, 'success');
      return;
    } else if (action === 'prelaunch-golive') {
      if (!confirm('Go live?\n\nThe shared test password is switched off, and every employee must choose a new password the next time they sign in. Until they do, the test password still works for them.')) return;
      const data = await adminApi('/api/admin/prelaunch/go-live', 'POST', {});
      showToast(`Live. ${data.mustChange} employee${data.mustChange === 1 ? ' is' : 's are'} asked to choose a new password.`, 'success');
      await loadWorkspaceAdmin();
      return;
    } else if (action === 'import-accounts') {
      const result = await window.electronAPI.importAccountsFile();
      if (!result || result.canceled) return;
      admin.importNotes = result.notes || [];
      admin.bulkText = document.getElementById('admin-bulk')?.value || admin.bulkText || '';
      if (result.accounts && result.accounts.length) {
        admin.pending = [...(admin.pending || []), ...result.accounts].slice(0, 500); // kept whole, with every field from the file
        showToast(`${result.accounts.length} ${result.accounts.length === 1 ? 'person' : 'people'} read from the file. Check the list, then create.`, 'success');
      }
      refreshAccountsForms();
      return;
    } else if (action === 'clear-pending') {
      admin.pending = [];
      admin.importNotes = [];
      admin.bulkText = document.getElementById('admin-bulk')?.value || admin.bulkText || '';
      refreshAccountsForms();
      return;
    } else if (action === 'accounts-template') {
      const saved = await window.electronAPI.saveAccountsCsv('template');
      if (saved && saved.saved) showToast('Template saved.', 'success');
      return;
    } else if (action === 'save-credentials') {
      const saved = await window.electronAPI.saveAccountsCsv('credentials', admin.lastCreated.created.map((c) => ({ username: c.username, email: c.email, password: c.password })));
      if (saved && saved.saved) showToast('Saved. Keep that file private: it holds passwords.', 'success');
      return;
    } else if (action === 'copy-credentials') {
      await navigator.clipboard.writeText(admin.lastCreated.created.map((c) => `${c.username}\t${c.email}\t${c.password}`).join('\n'));
      showToast('Copied.', 'success');
      return;
    } else if (action === 'copy-code') {
      await navigator.clipboard.writeText(admin.lastCode || '');
      showToast('Invitation code copied.', 'success');
    } else if (action === 'save-user') {
      const row = button.closest('[data-admin-user]');
      const userId = Number(row.dataset.adminUser);
      const accountType = row.querySelector('[data-admin-type]').value;
      const isSuperadmin = row.querySelector('[data-admin-superadmin]').checked;
      if (accountType === 'guest' && !confirm('Make this person a guest? They keep their current channels but lose moderator roles, cannot join or create channels, and can only message people in their channels.')) return;
      await adminApi(`/api/admin/users/${userId}`, 'PATCH', { accountType, isSuperadmin });
      const hrBox = row.querySelector('[data-admin-hr]');
      if (hrBox && accountType === 'member') await adminApi(`/api/hr/employees/${userId}/hr-role`, 'PUT', { isHr: hrBox.checked });
      showToast('Account updated.', 'success');
      await loadWorkspaceAdmin();
      await loadUsers();
    }
  } catch (err) {
    showToast(err.message || 'Could not apply the change.', 'error');
  }
}

async function handleAdminAccountsSubmit(form, event) {
  event.preventDefault();
  const admin = adminState();
  const values = new FormData(form);
  const typed = parseBulkLines(values.get('bulk'));
  const fromFile = admin.pending || [];
  const accounts = [...fromFile, ...typed];
  admin.bulkText = values.get('bulk') || '';
  if (!accounts.length) { showToast('Add at least one person.', 'error'); return; }
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const result = { created: [], skipped: [], warnings: [], createdDepartments: [] };
    for (let i = 0; i < accounts.length; i += 100) { // the server takes 100 at a time
      const data = await adminApi('/api/admin/users', 'POST', {
        accounts: accounts.slice(i, i + 100),
        accountType: values.get('accountType'),
        channelIds: values.getAll('channelIds').map(Number),
      });
      result.created.push(...data.created);
      result.skipped.push(...data.skipped);
      result.warnings.push(...(data.warnings || []));
      (data.createdDepartments || []).forEach((name) => { if (!result.createdDepartments.includes(name)) result.createdDepartments.push(name); });
    }
    admin.lastCreated = result;
    // what was created leaves the box; what was skipped stays so it can be fixed and tried again
    const skippedNames = new Set(result.skipped.map((s) => s.username));
    admin.pending = fromFile.filter((a) => skippedNames.has(a.username));
    admin.bulkText = typed.filter((a) => skippedNames.has(a.username)).map(bulkLine).join('\n');
    admin.importNotes = [];
    showToast(result.created.length ? `${result.created.length} account${result.created.length === 1 ? '' : 's'} created.` : 'No accounts were created.', result.created.length ? 'success' : 'error');
    refreshAccountsForms();
    if (state.moderation && state.moderation.isSuperadmin) await loadWorkspaceAdmin();
    await loadUsers();
    if (typeof reloadEmployeeManagement === 'function') reloadEmployeeManagement();
  } catch (err) {
    showToast(err.message || 'Could not create the accounts.', 'error');
    if (button) button.disabled = false;
  }
}

async function handleAdminSubmit(event) {
  const accountsForm = event.target.closest('[data-admin-form="accounts"]');
  if (accountsForm) { await handleAdminAccountsSubmit(accountsForm, event); return; }
  const form = event.target.closest('[data-admin-form="invitation"]');
  if (!form) return;
  event.preventDefault();
  const admin = adminState();
  try {
    const values = new FormData(form);
    const data = await adminApi('/api/admin/invitations', 'POST', {
      accountType: values.get('accountType'),
      expiresInHours: Number(values.get('expiresInHours')),
      note: values.get('note') || '',
      channelIds: values.getAll('channelIds').map(Number),
    });
    admin.lastCode = data.code;
    showToast('Invitation created.', 'success');
    await loadWorkspaceAdmin();
  } catch (err) {
    showToast(err.message || 'Could not create the invitation.', 'error');
  }
}

function setupAdminFeatures() {
  document.addEventListener('click', handleAdminClick);
  document.addEventListener('submit', handleAdminSubmit);
  document.addEventListener('input', (event) => {
    if (!event.target.matches?.('[data-workspace-member-search]')) return;
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('[data-workspace-member-list] [data-admin-user]').forEach((row) => {
      row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
    });
  });
}
