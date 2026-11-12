// IT Avenue Workspace - the Permissions card on a channel in Moderation (docs/ROLES_DESIGN.md, phase 3).
//
// One row per role (and per person with their own settings), one column per channel permission. Each cell is Inherit
// (use what the role gives), Allow or Deny. Changes save at once. The card is hidden for anyone who may not change them.

const channelPermState = { channelId: null, permissions: [], roles: [], people: [] };

function permCell(item, key) {
  const value = item.deny.includes(key) ? 'deny' : item.allow.includes(key) ? 'allow' : 'inherit';
  return `<td class="role-col"><select class="perm-select perm-${value}" data-perm-key="${escapeHtml(key)}" aria-label="${escapeHtml(key)}">
    <option value="inherit"${value === 'inherit' ? ' selected' : ''}>Inherit</option>
    <option value="allow"${value === 'allow' ? ' selected' : ''}>Allow</option>
    <option value="deny"${value === 'deny' ? ' selected' : ''}>Deny</option></select></td>`;
}

function renderChannelPermissions() {
  const host = document.getElementById('moderation-channel-permissions');
  if (!host) return;
  const { permissions, roles, people } = channelPermState;
  const head = `<tr><th>Who</th>${permissions.map((p) => `<th class="role-col" title="${escapeHtml(p.label)}">${escapeHtml(p.label)}</th>`).join('')}<th></th></tr>`;
  const roleRows = roles.map((r) => `<tr data-perm-type="role" data-perm-id="${r.id}">
    <td><span class="role-dot" style="background:${escapeHtml(r.color)}"></span> <strong>${escapeHtml(r.name)}</strong></td>
    ${permissions.map((p) => permCell(r, p.key)).join('')}<td></td></tr>`).join('');
  const personRows = people.map((p) => `<tr data-perm-type="user" data-perm-id="${p.id}">
    <td><strong>${escapeHtml(p.name)}</strong><small>Person</small></td>
    ${permissions.map((perm) => permCell(p, perm.key)).join('')}
    <td><button type="button" class="btn small" data-perm-remove aria-label="Remove settings for ${escapeHtml(p.name)}">Remove</button></td></tr>`).join('');
  const members = (state.channelMembers && state.channelMembers[channelPermState.channelId]) || [];
  const addable = members.filter((m) => !people.some((p) => p.id === m.id));
  host.innerHTML = `
    <div class="moderation-card">
      <h2>Permissions</h2>
      <p class="moderation-help">Choose what each role, or a single person, can do in this channel. Inherit means "whatever their role allows". Deny beats Inherit; a person's own setting beats their roles. To make a read-only channel, deny Send messages for Everyone and allow it for the roles that may post. To make it private, deny See the channel for Everyone and allow it for one role. Owners always have everything.</p>
      <div class="role-table-wrap"><table class="role-table"><thead>${head}</thead><tbody>${roleRows}${personRows}</tbody></table></div>
      <div class="moderation-inline perm-add">
        <select id="perm-add-person" aria-label="Add a person"><option value="">Add a person…</option>${addable.map((m) => `<option value="${m.id}">${escapeHtml(typeof mentionLabel === 'function' ? mentionLabel(m) : m.username)}</option>`).join('')}</select>
        <button type="button" class="btn" data-perm-add>Add person</button>
      </div>
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
    channelPermState.people = data.people;
    renderChannelPermissions();
  } catch (err) {
    console.error('Load channel permissions error:', err);
    host.innerHTML = '';
  }
}

async function saveChannelPermission(row) {
  const select = [...row.querySelectorAll('select[data-perm-key]')];
  const allow = select.filter((s) => s.value === 'allow').map((s) => s.dataset.permKey);
  const deny = select.filter((s) => s.value === 'deny').map((s) => s.dataset.permKey);
  const res = await api(`/api/channels/${channelPermState.channelId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ subjectType: row.dataset.permType, subjectId: Number(row.dataset.permId), allow, deny }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showToast(data.error || 'Could not save.', 'error'); loadChannelPermissionsCard(channelPermState.channelId); return false; }
  const list = row.dataset.permType === 'role' ? channelPermState.roles : channelPermState.people;
  const item = list.find((entry) => String(entry.id) === row.dataset.permId);
  if (item) { item.allow = allow; item.deny = deny; }
  return true;
}

if (typeof document !== 'undefined') {
  document.addEventListener('change', async (event) => {
    const select = event.target && event.target.closest ? event.target.closest('select[data-perm-key]') : null;
    if (!select) return;
    select.className = `perm-select perm-${select.value}`;
    await saveChannelPermission(select.closest('tr'));
  });
  document.addEventListener('click', async (event) => {
    if (!event.target.closest || !event.target.closest('#moderation-channel-permissions')) return;
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
