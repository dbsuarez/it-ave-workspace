// IT Avenue Workspace - user groups (@group mentions) and incoming webhooks.
//
// Loaded before renderer.js; defines functions only.

// ============================================================
// User groups
// ============================================================
async function loadUserGroups() {
  try {
    const res = await api('/api/user-groups');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load user groups');
    state.userGroups = data.groups || [];
  } catch (err) {
    console.error('Load user groups error:', err);
    state.userGroups = state.userGroups || [];
  }
}

function userGroupHandles() {
  return [...(state.userGroups || []).map((group) => group.handle), ...(state.roleMentions || []).map((role) => role.handle)];
}

// Entries for the @ picker, shaped like channel members.
function groupMentionCandidates() {
  const groups = (state.userGroups || []).map((group) => ({
    id: `group-${group.id}`,
    username: group.handle,
    avatarColor: '#1264A3',
    role: `group · ${group.members.length}`,
    isGroup: true,
  }));
  const roles = (state.roleMentions || []).map((role) => ({
    id: `role-${role.id}`,
    username: role.handle,
    avatarColor: role.color,
    role: `role · ${role.memberCount}`,
    isGroup: true,
  }));
  return [...groups, ...roles];
}

// The roles anyone can @mention, loaded at start and whenever roles change.
async function loadRoleMentions() {
  try {
    const res = await api('/api/roles/mentionable');
    const data = await res.json();
    if (res.ok) state.roleMentions = data.roles || [];
  } catch (err) {
    console.error('Load role mentions error:', err);
  }
}

async function handleUserGroupsUpdated() {
  await loadUserGroups();
  if (state.view === 'channel' && state.currentChannelId) {
    const container = document.getElementById('messages');
    const scrollTop = container.scrollTop;
    renderMessages('messages', state.messages[state.currentChannelId] || []);
    container.scrollTop = scrollTop;
  }
  if (document.getElementById('admin-user-groups')) renderUserGroupsAdmin();
}

function userGroupsAdminHtml() {
  return '<div class="moderation-card" id="admin-user-groups" data-mod-tab="people"></div>';
}

function renderUserGroupsAdmin() {
  const card = document.getElementById('admin-user-groups');
  if (!card) return;
  const people = (adminState().users || []).filter((user) => user.accountType !== 'bot');
  const rows = (state.userGroups || []).map((group) => {
    const memberIds = new Set(group.members.map((member) => Number(member.id)));
    const addable = people.filter((user) => !memberIds.has(Number(user.id)));
    return `
      <div class="user-group-row" data-user-group="${group.id}">
        <div class="moderation-row">
          <span><strong>@${escapeHtml(group.handle)}</strong>${group.name !== group.handle ? ` · ${escapeHtml(group.name)}` : ''}</span>
          <div class="moderation-row-actions">
            <select data-group-add-user aria-label="Add someone to @${escapeHtml(group.handle)}"${addable.length ? '' : ' disabled'}>
              ${addable.length ? addable.map((user) => `<option value="${user.id}">${escapeHtml(user.username)}</option>`).join('') : '<option value="">Everyone is in this group</option>'}
            </select>
            <button class="btn" type="button" data-group-action="add-member"${addable.length ? '' : ' disabled'}>Add</button>
            <button class="btn" type="button" data-group-action="delete-group">Delete group</button>
          </div>
        </div>
        <div class="user-group-members">
          ${group.members.length
    ? group.members.map((member) => `<span class="user-group-chip">${escapeHtml(member.username)}<button type="button" data-group-action="remove-member" data-user-id="${member.id}" aria-label="Remove ${escapeHtml(member.username)}">×</button></span>`).join('')
    : '<span class="form-note">No members yet.</span>'}
        </div>
      </div>`;
  }).join('');
  card.innerHTML = `
    <h2>User groups</h2>
    <p class="form-note">Mention a group with @handle to notify everyone in it who is in that channel.</p>
    <form class="moderation-inline" data-group-form="create">
      <label>Handle<input name="handle" type="text" maxlength="31" placeholder="e.g. support" required></label>
      <label>Name (optional)<input name="name" type="text" maxlength="80" placeholder="e.g. Customer support"></label>
      <button class="btn primary" type="submit">Create group</button>
    </form>
    <div class="moderation-list">${rows || '<p>No groups yet.</p>'}</div>`;
}

async function handleUserGroupClick(event) {
  const button = event.target.closest('[data-group-action]');
  if (!button) return;
  const row = button.closest('[data-user-group]');
  const groupId = row?.dataset.userGroup;
  const action = button.dataset.groupAction;
  try {
    if (action === 'add-member') {
      const userId = row.querySelector('[data-group-add-user]').value;
      if (!userId) return;
      await adminApi(`/api/user-groups/${groupId}/members/${userId}`, 'PUT');
    } else if (action === 'remove-member') {
      await adminApi(`/api/user-groups/${groupId}/members/${button.dataset.userId}`, 'DELETE');
    } else if (action === 'delete-group') {
      if (!confirm('Delete this group? Its handle will stop notifying people.')) return;
      await adminApi(`/api/user-groups/${groupId}`, 'DELETE');
    }
    await loadUserGroups();
    renderUserGroupsAdmin();
  } catch (err) {
    showToast(err.message || 'Could not update the group.', 'error');
  }
}

async function handleUserGroupSubmit(event) {
  const form = event.target.closest('[data-group-form="create"]');
  if (!form) return;
  event.preventDefault();
  try {
    await adminApi('/api/user-groups', 'POST', {
      handle: form.elements.handle.value.trim().toLowerCase(),
      name: form.elements.name.value,
    });
    await loadUserGroups();
    renderUserGroupsAdmin();
    showToast('Group created.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not create the group.', 'error');
  }
}

// ============================================================
// Incoming webhooks (channel moderators)
// ============================================================
async function loadChannelWebhooks(channelId, newPath = null) {
  const host = document.getElementById('moderation-channel-data');
  if (!host) return;
  let card = document.getElementById('channel-webhooks');
  if (!card) {
    card = document.createElement('div');
    card.className = 'moderation-card';
    card.id = 'channel-webhooks';
    host.insertBefore(card, document.getElementById('channel-danger-zone'));
  }
  card.dataset.channelId = String(channelId);
  try {
    const data = await adminApi(`/api/webhooks?channelId=${channelId}`);
    const rows = (data.webhooks || []).map((hook) => `
      <div class="moderation-row">
        <span><strong>${escapeHtml(hook.name)}</strong><br><small>Created by ${escapeHtml(hook.createdBy)} · ${hook.lastUsedAt ? `last used ${escapeHtml(new Date(hook.lastUsedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}` : 'never used'}</small></span>
        <div class="moderation-row-actions"><button class="btn" type="button" data-webhook-delete="${hook.id}">Delete</button></div>
      </div>`).join('');
    const url = newPath ? `${API_BASE}${newPath}` : '';
    card.innerHTML = `
      <h2>Incoming webhooks</h2>
      <p class="form-note">Lets another system post messages into this channel by sending JSON to a secret address.</p>
      <form class="moderation-inline" data-webhook-form>
        <label>Name shown on its messages<input name="name" type="text" minlength="2" maxlength="40" placeholder="e.g. Build server" required></label>
        <button class="btn primary" type="submit">Create webhook</button>
      </form>
      ${newPath ? `<div class="admin-invite-code">Address (shown only once):<br><code id="webhook-new-url">${escapeHtml(url)}</code>
        <button class="btn" type="button" data-webhook-copy>Copy</button><br>
        <small>Example: curl -X POST -H "Content-Type: application/json" -d "{\\"text\\":\\"Hello\\"}" ${escapeHtml(url)}</small></div>` : ''}
      <div class="moderation-list">${rows || '<p>No webhooks for this channel.</p>'}</div>`;
  } catch (err) {
    card.innerHTML = `<h2>Incoming webhooks</h2><p>${escapeHtml(err.message || 'Could not load webhooks.')}</p>`;
  }
}

async function handleWebhookClick(event) {
  const card = event.target.closest('#channel-webhooks');
  if (!card) return;
  const channelId = Number(card.dataset.channelId);
  if (event.target.closest('[data-webhook-copy]')) {
    await navigator.clipboard.writeText(document.getElementById('webhook-new-url').textContent);
    showToast('Webhook address copied.', 'success');
    return;
  }
  const remove = event.target.closest('[data-webhook-delete]');
  if (!remove || !confirm('Delete this webhook? Its address will stop working.')) return;
  try {
    await adminApi(`/api/webhooks/${remove.dataset.webhookDelete}`, 'DELETE');
    await loadChannelWebhooks(channelId);
  } catch (err) {
    showToast(err.message || 'Could not delete the webhook.', 'error');
  }
}

async function handleWebhookSubmit(event) {
  const form = event.target.closest('[data-webhook-form]');
  if (!form) return;
  event.preventDefault();
  const channelId = Number(form.closest('#channel-webhooks').dataset.channelId);
  try {
    const data = await adminApi('/api/webhooks', 'POST', { channelId, name: form.elements.name.value });
    await loadChannelWebhooks(channelId, data.path);
    showToast('Webhook created. Copy its address now.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not create the webhook.', 'error');
  }
}

function setupIntegrationFeatures() {
  const host = document.getElementById('moderation-content');
  host?.addEventListener('click', handleUserGroupClick);
  host?.addEventListener('submit', handleUserGroupSubmit);
  host?.addEventListener('click', handleWebhookClick);
  host?.addEventListener('submit', handleWebhookSubmit);
}
