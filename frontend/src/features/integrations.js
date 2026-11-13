// IT Avenue Workspace - @mentionable departments and roles, plus incoming webhooks.
//
// Loaded before renderer.js; defines functions only.

function roleHandle(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ============================================================
// Departments (@department mention)
// ============================================================
async function loadDepartments() {
  try {
    const res = await api('/api/hr/departments');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load departments');
    state.departments = data.departments || [];
  } catch (err) {
    console.error('Load departments error:', err);
    state.departments = state.departments || [];
  }
}

function departmentHandles() {
  return (state.departments || []).map((department) => roleHandle(department.name));
}

function groupHandles() {
  return [...departmentHandles(), ...(state.roleMentions || []).map((role) => role.handle)];
}

// Entries for the @ picker, shaped like channel members.
function groupMentionCandidates() {
  const departments = (state.departments || []).map((department) => ({
    id: `department-${department.id}`,
    username: roleHandle(department.name),
    avatarColor: '#0F766E',
    role: `department · ${department.memberCount}${department.headUsername ? ` · headed by ${department.headUsername}` : ''}`,
    isGroup: true,
  }));
  const roles = (state.roleMentions || []).map((role) => ({
    id: `role-${role.id}`,
    username: role.handle,
    avatarColor: role.color,
    role: `role · ${role.memberCount}`,
    isGroup: true,
  }));
  return [...departments, ...roles];
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

// ============================================================
// Incoming webhooks (channel moderators)
// ============================================================
async function loadChannelWebhooks(channelId, newPath = null) {
  const host = document.querySelector('[data-channel-panel="integrations"]') || document.getElementById('moderation-channel-data');
  if (!host) return;
  let card = document.getElementById('channel-webhooks');
  if (!card) {
    card = document.createElement('div');
    card.className = 'moderation-card';
    card.id = 'channel-webhooks';
    host.appendChild(card);
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
  host?.addEventListener('click', handleWebhookClick);
  host?.addEventListener('submit', handleWebhookSubmit);
}
