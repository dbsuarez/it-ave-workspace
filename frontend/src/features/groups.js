// IT Avenue Workspace - group direct messages (three or more people).
//
// Loaded before renderer.js; defines functions only. Group conversations reuse
// the DM view: `state.currentGroupId` says a group, not a person, is open.

function groupState() {
  if (!state.groups) state.groups = [];
  if (!state.groupMessages) state.groupMessages = {};
  return state.groups;
}

function groupTitle(group) {
  if (group.name) return group.name;
  const others = group.members.filter((member) => Number(member.id) !== Number(state.user.id));
  return others.map((member) => member.username).join(', ') || 'Just you';
}

async function loadGroups() {
  try {
    const res = await api('/api/conversations');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load group messages');
    state.groups = data.conversations || [];
  } catch (err) {
    console.error('Load group messages error:', err);
  }
  renderGroupList();
}

function renderGroupList() {
  const list = document.getElementById('group-list');
  if (!list) return;
  const groups = groupState();
  if (!groups.length) {
    list.innerHTML = '<p class="group-list-empty">No group messages yet.</p>';
    return;
  }
  list.innerHTML = groups.map((group) => {
    const active = Number(state.currentGroupId) === Number(group.id) && state.section === 'dms';
    return `
      <div class="nav-item${active ? ' active' : ''}" data-group-id="${group.id}" title="${escapeHtml(group.members.map((m) => m.username).join(', '))}">
        <span class="group-count">${group.members.length}</span>
        <span class="group-name">${escapeHtml(groupTitle(group))}</span>
        ${group.unreadCount > 0 && !active ? `<span class="unread-badge">${group.unreadCount}</span>` : ''}
      </div>`;
  }).join('');
}

function setGroupHeaderActions(visible) {
  ['btn-group-add', 'btn-group-rename', 'btn-group-leave'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.hidden = !visible;
  });
  const attach = document.getElementById('btn-dm-attach');
  if (attach) attach.hidden = visible;
}

// Called by openDM so a one-to-one conversation replaces any open group.
function leaveGroupView() {
  state.currentGroupId = null;
  setGroupHeaderActions(false);
}

function renderGroupHeader(group) {
  els.dmTitle.textContent = groupTitle(group);
  els.dmTopic.textContent = `${group.members.length} people: ${group.members.map((m) => m.username).join(', ')}`;
}

async function openGroup(groupId) {
  const group = groupState().find((item) => Number(item.id) === Number(groupId));
  if (!group) return;
  state.currentGroupId = group.id;
  state.currentDMId = null;
  state.currentChannelId = null;
  cancelReply();
  state.view = 'dm';
  state.section = 'dms';
  updateRail('dms');
  showPane('dms');
  showView('dm');
  renderGroupHeader(group);
  setGroupHeaderActions(true);
  group.unreadCount = 0;
  renderSidebar();

  const container = document.getElementById('dm-messages');
  renderSkeleton(container);
  try {
    const res = await api(`/api/conversations/${group.id}/messages?limit=100`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load messages');
    if (Number(state.currentGroupId) !== Number(group.id)) return;
    state.groupMessages[group.id] = mergeLoadedMessages(data.messages, state.groupMessages[group.id] || []);
    renderMessages('dm-messages', state.groupMessages[group.id]);
    api(`/api/conversations/${group.id}/read`, { method: 'POST' }).catch(() => {});
  } catch (err) {
    console.error('Load group messages error:', err);
    container.innerHTML = emptyRecordMarkup('Could not load messages', err.message || 'Please try again.');
  }
}

function sendGroupMessage() {
  const text = els.dmMessageInput.value.trim();
  const groupId = state.currentGroupId;
  if (!text || !groupId) return;
  if (!state.socketAuthenticated) {
    showToast('Chat is reconnecting. Please try again in a moment.', 'error');
    return;
  }
  const clientMessageId = createClientMessageId();
  const messages = state.groupMessages[groupId] || (state.groupMessages[groupId] = []);
  upsertMessage(messages, {
    id: `pending-${clientMessageId}`,
    clientMessageId,
    conversationId: groupId,
    senderId: state.user.id,
    senderUsername: state.user.username,
    senderAvatarColor: state.user.avatarColor,
    content: text,
    createdAt: new Date().toISOString(),
    attachments: [],
    pending: true,
  });
  renderMessages('dm-messages', messages);
  els.dmMessageInput.value = '';
  state.socket.emit('send_group_message', { conversationId: groupId, content: text, clientMessageId });
}

// Rolls back an optimistic group message the server rejected.
function removePendingGroupMessage(clientMessageId) {
  Object.keys(state.groupMessages || {}).forEach((groupId) => {
    const messages = state.groupMessages[groupId];
    const filtered = messages.filter((message) => !(message.pending && message.clientMessageId === clientMessageId));
    if (filtered.length === messages.length) return;
    state.groupMessages[groupId] = filtered;
    if (Number(state.currentGroupId) === Number(groupId) && state.view === 'dm') {
      renderMessages('dm-messages', filtered);
    }
  });
}

function handleNewGroupMessage(message) {
  groupState();
  const groupId = message.conversationId;
  const messages = state.groupMessages[groupId] || (state.groupMessages[groupId] = []);
  upsertMessage(messages, message);
  const onScreen = Number(state.currentGroupId) === Number(groupId) && state.view === 'dm' && state.section === 'dms';
  const group = state.groups.find((item) => Number(item.id) === Number(groupId));
  const mine = Number(message.senderId) === Number(state.user.id);
  if (onScreen) {
    renderMessages('dm-messages', messages);
    if (!mine) api(`/api/conversations/${groupId}/read`, { method: 'POST' }).catch(() => {});
  } else if (!mine && group) {
    group.unreadCount = (group.unreadCount || 0) + 1;
    renderGroupList();
  }
  if (!mine && !(onScreen && document.hasFocus())) {
    notifyUser('dm', `${message.senderUsername} in ${group ? groupTitle(group) : 'a group'}: ${message.content}`);
  }
}

function handleConversationUpdated({ conversation }) {
  if (!conversation) return;
  const groups = groupState();
  const index = groups.findIndex((item) => Number(item.id) === Number(conversation.id));
  if (index === -1) groups.unshift(conversation);
  else groups[index] = { ...conversation, unreadCount: groups[index].unreadCount };
  renderGroupList();
  if (Number(state.currentGroupId) === Number(conversation.id) && state.view === 'dm') {
    renderGroupHeader(conversation);
  }
}

function handleConversationRemoved({ conversationId }) {
  state.groups = groupState().filter((item) => Number(item.id) !== Number(conversationId));
  delete state.groupMessages[conversationId];
  renderGroupList();
  if (Number(state.currentGroupId) === Number(conversationId)) {
    leaveGroupView();
    els.dmTitle.textContent = 'Direct Messages';
    els.dmTopic.textContent = '';
    els.dmMessages.innerHTML = emptyRecordMarkup('You left this group', 'Pick another conversation from the list.');
    showToast('You are no longer in that group.');
  }
}

// ---- Create / add people ----
function openGroupModal(mode) {
  const modal = document.getElementById('modal-group');
  const current = mode === 'add'
    ? groupState().find((item) => Number(item.id) === Number(state.currentGroupId))
    : null;
  const memberIds = new Set((current?.members || []).map((member) => Number(member.id)));
  const candidates = (state.users || []).filter((user) => !memberIds.has(Number(user.id)));
  modal.dataset.mode = mode;
  document.getElementById('group-modal-title').textContent = mode === 'add' ? 'Add people' : 'New group message';
  document.getElementById('group-name-row').hidden = mode === 'add';
  document.getElementById('group-name').value = '';
  document.getElementById('btn-save-group').textContent = mode === 'add' ? 'Add' : 'Create group';
  document.getElementById('group-user-list').innerHTML = candidates.length
    ? candidates.map((user) => `
      <label class="preference-toggle">
        <input type="${mode === 'add' ? 'radio' : 'checkbox'}" name="group-user" value="${user.id}">
        <span>${escapeHtml(user.username)}</span>
      </label>`).join('')
    : '<p class="form-note">Everyone is already in this group.</p>';
  openSettingsModal(modal);
}

async function saveGroupModal(event) {
  event.preventDefault();
  const modal = document.getElementById('modal-group');
  const selected = [...document.querySelectorAll('#group-user-list input:checked')].map((input) => Number(input.value));
  try {
    if (modal.dataset.mode === 'add') {
      if (selected.length !== 1) throw new Error('Choose a person to add.');
      const res = await api(`/api/conversations/${state.currentGroupId}/members`, {
        method: 'POST', body: JSON.stringify({ userId: selected[0] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add that person');
      handleConversationUpdated(data);
      closeSettingsModal();
      showToast('Person added to the group.', 'success');
    } else {
      if (selected.length < 2) throw new Error('Choose at least two people. For one person, use a direct message.');
      const res = await api('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ memberIds: selected, name: document.getElementById('group-name').value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the group');
      handleConversationUpdated(data);
      closeSettingsModal();
      await openGroup(data.conversation.id);
    }
  } catch (err) {
    showToast(err.message || 'Could not save the group.', 'error');
  }
}

async function renameCurrentGroup() {
  const group = groupState().find((item) => Number(item.id) === Number(state.currentGroupId));
  if (!group) return;
  const name = await askText('Group name (leave blank to show member names):', { maxLength: 80, placeholder: group.name });
  if (name === null) return;
  try {
    const res = await api(`/api/conversations/${group.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not rename the group');
    handleConversationUpdated(data);
  } catch (err) {
    showToast(err.message || 'Could not rename the group.', 'error');
  }
}

async function leaveCurrentGroup() {
  const groupId = state.currentGroupId;
  if (!groupId || !confirm('Leave this group? You will stop receiving its messages.')) return;
  try {
    const res = await api(`/api/conversations/${groupId}/members/${state.user.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not leave the group');
    handleConversationRemoved({ conversationId: groupId });
  } catch (err) {
    showToast(err.message || 'Could not leave the group.', 'error');
  }
}

function setupGroupFeatures() {
  document.getElementById('group-list')?.addEventListener('click', (event) => {
    const item = event.target.closest('[data-group-id]');
    if (item) { event.stopPropagation(); openGroup(Number(item.dataset.groupId)); }
  });
  document.getElementById('btn-new-group')?.addEventListener('click', (event) => {
    event.stopPropagation();
    openGroupModal('create');
  });
  document.getElementById('btn-group-add')?.addEventListener('click', () => openGroupModal('add'));
  document.getElementById('btn-group-rename')?.addEventListener('click', renameCurrentGroup);
  document.getElementById('btn-group-leave')?.addEventListener('click', leaveCurrentGroup);
  document.getElementById('group-form')?.addEventListener('submit', saveGroupModal);
  document.getElementById('btn-cancel-group')?.addEventListener('click', closeSettingsModal);
  document.getElementById('btn-close-group')?.addEventListener('click', closeSettingsModal);
}
