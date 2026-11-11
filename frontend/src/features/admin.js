// IT Avenue Workspace - guest accounts, invitations, and workspace member
// administration (Superadmin section of the Moderation view).
//
// Loaded before renderer.js; defines functions only.

function adminState() {
  if (!state.admin) state.admin = { users: [], invitations: [], mode: 'open', lastCode: null };
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
  section.innerHTML = '<div class="loading-state">Loading workspace administration…</div>';
  const admin = adminState();
  try {
    const [users, invitations, registration] = await Promise.all([
      adminApi('/api/admin/users'),
      adminApi('/api/admin/invitations'),
      adminApi('/api/admin/registration'),
    ]);
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

function renderWorkspaceAdmin() {
  const section = document.getElementById('admin-workspace');
  if (!section) return;
  const admin = adminState();
  const channelName = (id) => state.channels.find((channel) => Number(channel.id) === Number(id))?.name || `channel ${id}`;

  const userRows = admin.users.map((user) => {
    const self = Number(user.id) === Number(state.user.id);
    return `
      <div class="moderation-row admin-user-row" data-admin-user="${user.id}">
        <span><strong>${escapeHtml(user.username)}</strong>${self ? ' (you)' : ''}<br><small>${escapeHtml(user.email)} · ${user.channelCount} channel${user.channelCount === 1 ? '' : 's'}${user.moderatorChannelCount ? ` · moderator in ${user.moderatorChannelCount}` : ''}</small></span>
        <div class="moderation-row-actions">
          <select data-admin-type aria-label="Account type for ${escapeHtml(user.username)}"${self ? ' disabled' : ''}>
            <option value="member"${user.accountType === 'member' ? ' selected' : ''}>Member</option>
            <option value="guest"${user.accountType === 'guest' ? ' selected' : ''}>Guest</option>
          </select>
          <label class="admin-inline-check"><input type="checkbox" data-admin-superadmin${user.isSuperadmin ? ' checked' : ''}${self ? ' disabled' : ''}> Superadmin</label>
          <button class="btn" type="button" data-admin-action="save-user"${self ? ' disabled' : ''}>Save</button>
        </div>
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
    <div class="moderation-card">
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
    <form class="moderation-card" data-admin-form="invitation">
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
    <div class="moderation-card"><h2>Invitations</h2><div class="moderation-list">${invitationRows || '<p>No invitations yet.</p>'}</div></div>
    <div class="moderation-card"><h2>Workspace members</h2><div class="moderation-list">${userRows}</div></div>`;
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
      showToast('Account updated.', 'success');
      await loadWorkspaceAdmin();
      await loadUsers();
    }
  } catch (err) {
    showToast(err.message || 'Could not apply the change.', 'error');
  }
}

async function handleAdminSubmit(event) {
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
  const host = document.getElementById('moderation-content');
  host?.addEventListener('click', handleAdminClick);
  host?.addEventListener('submit', handleAdminSubmit);
}
