// IT Avenue Workspace - scheduled messages, personal sidebar sections, and
// channel resource tabs (pins, files, canvases, lists, links).
//
// Loaded before renderer.js; defines functions only.

// ============================================================
// Scheduled messages
// ============================================================
function scheduledState() {
  if (!state.scheduled) state.scheduled = { items: [], target: null };
  return state.scheduled;
}

async function loadScheduled() {
  try {
    const res = await api('/api/scheduled');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load scheduled messages');
    scheduledState().items = data.scheduled || [];
  } catch (err) {
    console.error('Load scheduled messages error:', err);
  }
}

// `kind` is 'channel' or 'dm'; the text comes from that composer.
function openScheduleModal(kind) {
  const input = kind === 'channel' ? els.messageInput : els.dmMessageInput;
  const text = input.value.trim();
  if (!text) { showToast('Write the message first, then schedule it.', 'error'); return; }
  if (kind === 'dm' && state.currentGroupId) {
    showToast('Scheduling is available for channels and one-to-one messages.', 'error');
    return;
  }
  const target = kind === 'channel'
    ? { channelId: state.currentChannelId, label: els.channelTitle.textContent }
    : { receiverId: state.currentDMId, label: els.dmTitle.textContent };
  if (!target.channelId && !target.receiverId) return;
  scheduledState().target = { ...target, kind, text };
  document.getElementById('schedule-target').textContent = `To ${target.label}`;
  document.getElementById('schedule-preview').textContent = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  document.getElementById('schedule-when').innerHTML = REMINDER_PRESETS
    .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  document.getElementById('schedule-custom-row').hidden = true;
  document.getElementById('schedule-custom').value = '';
  openSettingsModal(document.getElementById('modal-schedule'));
}

async function saveScheduledMessage(event) {
  event.preventDefault();
  const target = scheduledState().target;
  if (!target) return;
  const preset = document.getElementById('schedule-when').value;
  const custom = document.getElementById('schedule-custom').value;
  const when = preset === 'custom' ? (custom ? new Date(custom) : null) : reminderPresetTime(preset);
  if (!when || Number.isNaN(when.getTime())) { showToast('Pick a date and time.', 'error'); return; }
  try {
    const res = await api('/api/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        content: target.text,
        sendAt: when.toISOString(),
        ...(target.channelId ? { channelId: target.channelId } : { receiverId: target.receiverId }),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not schedule the message');
    (target.kind === 'channel' ? els.messageInput : els.dmMessageInput).value = '';
    closeSettingsModal();
    showToast(`Scheduled for ${when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Manage it under Later.`, 'success');
    await loadScheduled();
    if (state.section === 'later') renderLaterView();
  } catch (err) {
    showToast(err.message || 'Could not schedule the message.', 'error');
  }
}

function scheduledListHtml() {
  const items = scheduledState().items;
  if (!items.length) {
    return emptyRecordMarkup('Nothing scheduled', 'Write a message, then use the clock button next to Send.');
  }
  return items.map((item) => `
    <div class="later-item${item.failedAt ? ' failed' : ''}">
      <span class="later-item-body">
        <span class="later-item-title"><strong>${escapeHtml(item.channelName ? `#${item.channelName}` : (item.receiverUsername || 'Direct message'))}</strong> · ${item.failedAt ? 'Could not send' : 'Sends'} ${escapeHtml(new Date(item.sendAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</span>
        <span class="later-item-text">${escapeHtml(item.content)}</span>
        ${item.error ? `<span class="later-item-error">${escapeHtml(item.error)}</span>` : ''}
      </span>
      <button class="btn" type="button" data-cancel-scheduled="${item.id}">${item.failedAt ? 'Dismiss' : 'Cancel'}</button>
    </div>`).join('');
}

async function cancelScheduledMessage(id) {
  try {
    const res = await api(`/api/scheduled/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not cancel the message');
    await loadScheduled();
    renderLaterView();
  } catch (err) {
    showToast(err.message || 'Could not cancel the message.', 'error');
  }
}

async function handleScheduledDelivered() {
  await loadScheduled();
  if (state.section === 'later') renderLaterView();
}

async function handleScheduledFailed({ error }) {
  showToast(`A scheduled message could not be sent: ${error}`, 'error');
  await handleScheduledDelivered();
}

// ============================================================
// Personal sidebar sections
// ============================================================
function sidebarLayout() {
  if (!state.sidebarLayout) state.sidebarLayout = { sections: [], workspaceSections: [], workspaceCollapsed: [], canManageWorkspaceSections: false };
  return state.sidebarLayout;
}

async function loadSidebarLayout() {
  try {
    const res = await api('/api/settings/sidebar');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load your sidebar sections');
    state.sidebarLayout = data.layout || { sections: [], workspaceSections: [], workspaceCollapsed: [], canManageWorkspaceSections: false };
    const layout = state.sidebarLayout;
    const placed = new Set([...(layout.workspaceSections || []), ...(layout.sections || [])]
      .flatMap((section) => (section.channelIds || []).map(Number)));
    const ownUnplaced = (state.channels || []).filter((channel) => Number(channel.createdBy) === Number(state.user?.id)
      && !placed.has(Number(channel.id))).map((channel) => Number(channel.id));
    if (ownUnplaced.length) {
      if (!layout.sections.length) layout.sections.push({ id: 'my-channels', name: 'My channels', channelIds: [], collapsed: false });
      layout.sections[0].channelIds.push(...ownUnplaced);
      await saveSidebarLayout(layout);
      return;
    }
  } catch (err) {
    console.error('Load sidebar layout error:', err);
  }
  renderSidebar();
}

async function saveSidebarLayout(layout) {
  const res = await api('/api/settings/sidebar', { method: 'PUT', body: JSON.stringify({ layout }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not save your sidebar sections');
  state.sidebarLayout = data.layout;
  renderSidebar();
}

function channelNavItem(channel) {
  const active = state.currentChannelId === channel.id && state.section === 'home';
  const item = document.createElement('div');
  item.className = 'nav-item' + (active ? ' active' : '');
  const unread = channel.unreadCount || 0;
  item.innerHTML = `<span>#</span><span>${escapeHtml(channel.name)}</span>${unread > 0 && !active ? `<span class="unread-badge">${unread}</span>` : ''}`;
  item.title = channel.topic || '';
  item.onclick = (event) => { event.stopPropagation(); openChannel(channel.id); };
  return item;
}

// Fills #channel-list: the user's own sections first, then everything else.
function renderChannelNav() {
  const list = els.channelList;
  const layout = sidebarLayout();
  const collapsedWorkspace = new Set(layout.workspaceCollapsed || []);
  const workspaceSections = (layout.workspaceSections || [])
    .filter((section) => Array.isArray(section.channelIds))
    .map((section) => ({ ...section, collapsed: collapsedWorkspace.has(section.id), workspace: true }));
  const sections = [...workspaceSections, ...layout.sections.filter((section) => Array.isArray(section.channelIds))];
  const placed = new Set();
  const paneHome = document.getElementById('pane-home');
  paneHome?.classList.toggle('has-sections', sections.length > 0);

  sections.forEach((section) => {
    const channels = section.channelIds
      .map((id) => state.channels.find((channel) => Number(channel.id) === Number(id)))
      .filter(Boolean);
    channels.forEach((channel) => placed.add(Number(channel.id)));
    const unread = channels.reduce((sum, channel) => sum + (channel.unreadCount || 0), 0);
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'nav-label nav-section-label';
    label.dataset.sectionId = section.id;
    label.dataset.workspaceSection = section.workspace ? '1' : '0';
    label.setAttribute('aria-expanded', String(!section.collapsed));
    label.innerHTML = `<span class="nav-section-caret">${section.collapsed ? '▸' : '▾'}</span><span class="nav-section-name">${escapeHtml(section.name)}</span>${section.workspace ? '<span class="nav-section-lock" title="Workspace section" aria-label="Workspace section">◆</span>' : ''}${section.collapsed && unread ? `<span class="unread-badge">${unread}</span>` : ''}`;
    list.appendChild(label);
    if (!section.collapsed) {
      if (!channels.length) {
        const empty = document.createElement('p');
        empty.className = 'group-list-empty';
        empty.textContent = 'No channels in this section.';
        list.appendChild(empty);
      }
      channels.forEach((channel) => list.appendChild(channelNavItem(channel)));
    }
  });

  // What is left is split in two built-in groups: Channels, and Personal channels (yours, and nobody else is in them yet)
  const rest = state.channels.filter((channel) => !placed.has(Number(channel.id)));
  const { shared, personal } = splitPersonalChannels(rest, state.user && state.user.id);
  if (sections.length && shared.length) {
    const label = document.createElement('h4');
    label.className = 'nav-label';
    label.textContent = 'Channels';
    list.appendChild(label);
  }
  shared.forEach((channel) => list.appendChild(channelNavItem(channel)));
  if (personal.length) {
    const label = document.createElement('h4');
    label.className = 'nav-label nav-personal-label';
    label.textContent = 'Personal channels';
    label.title = 'Channels you created that nobody else is in yet. They move up to Channels when someone joins.';
    list.appendChild(label);
    personal.forEach((channel) => list.appendChild(channelNavItem(channel)));
  }
}

async function toggleSidebarSection(sectionId) {
  const layout = JSON.parse(JSON.stringify(sidebarLayout()));
  const workspace = (layout.workspaceSections || []).find((item) => item.id === sectionId);
  if (workspace) {
    const collapsed = new Set(layout.workspaceCollapsed || []);
    if (collapsed.has(sectionId)) collapsed.delete(sectionId); else collapsed.add(sectionId);
    layout.workspaceCollapsed = [...collapsed];
    state.sidebarLayout = layout;
    renderSidebar();
    try { await saveSidebarLayout(layout); } catch (err) { console.error('Save workspace section collapse error:', err); }
    return;
  }
  const section = layout.sections.find((item) => item.id === sectionId);
  if (!section) return;
  section.collapsed = !section.collapsed;
  state.sidebarLayout = layout;
  renderSidebar();
  try {
    await saveSidebarLayout(layout);
  } catch (err) {
    console.error('Save sidebar collapse error:', err);
  }
}

// ---- Organize dialog ----
function openSidebarModal() {
  state.sidebarDraft = JSON.parse(JSON.stringify(sidebarLayout()));
  state.workspaceSidebarDraft = { sections: JSON.parse(JSON.stringify(sidebarLayout().workspaceSections || [])) };
  state.sidebarAvailabilityDraft = Object.fromEntries(state.channels.map((channel) => [channel.id, Boolean(channel.availableToAll)]));
  state.sidebarChannelNameDraft = Object.fromEntries(state.channels.map((channel) => [channel.id, channel.name]));
  state.sidebarOrganizerTab = state.sidebarOrganizerTab || 'workspace';
  renderSidebarModal();
  openSettingsModal(document.getElementById('modal-sidebar'));
}

function renderSidebarModal() {
  const draft = state.sidebarDraft;
  const workspaceDraft = state.workspaceSidebarDraft || { sections: [] };
  const canManageWorkspace = Boolean(draft.canManageWorkspaceSections);
  const channelById = new Map(state.channels.map((channel) => [Number(channel.id), channel]));
  const canRenameChannel = (channel, readOnly) => !readOnly && Boolean(state.user?.isSuperadmin
    || state.moderation?.canManageChannels
    || Number(channel.createdBy) === Number(state.user?.id)
    || state.moderation?.moderatorChannelIds?.some((id) => Number(id) === Number(channel.id)));
  const canDeleteOrganizerChannel = (channel, readOnly) => !readOnly && Boolean(state.user?.isSuperadmin
    || state.moderation?.canManageChannels
    || Number(channel.createdBy) === Number(state.user?.id));
  const creatorName = (channel) => [channel.creatorFirstName, channel.creatorMiddleName, channel.creatorLastName]
    .filter(Boolean).join(' ') || channel.creatorUsername || 'Unknown owner';
  const channelCard = (channel, movable = true, showOwner = false) => `
    <div class="sidebar-channel-card${movable ? '' : ' locked'}" data-sidebar-channel-id="${channel.id}">
      ${showOwner ? '' : `<span class="sidebar-drag-handle" ${movable ? 'draggable="true"' : ''} title="${movable ? 'Drag to another section' : 'Workspace channels are managed centrally'}" aria-label="${movable ? 'Drag channel' : 'Locked workspace channel'}">⋮⋮</span>`}
      ${showOwner ? `<button type="button" class="avatar-mini sidebar-channel-owner" data-avatar-user="${channel.createdBy}" data-user-id="${channel.createdBy}" data-organizer-owner="${channel.id}" title="${escapeHtml(creatorName(channel))}" aria-label="Open ${escapeHtml(creatorName(channel))}'s menu" style="background:${escapeHtml(channel.creatorAvatarColor || '#64748b')}">${escapeHtml(creatorName(channel).charAt(0).toUpperCase())}</button>` : ''}
      ${canRenameChannel(channel, showOwner)
    ? `<input class="sidebar-channel-name" data-channel-name="${channel.id}" value="${escapeHtml(state.sidebarChannelNameDraft[channel.id] || channel.name)}" aria-label="Channel name">`
    : `<span class="sidebar-channel-name sidebar-channel-name-readonly">${escapeHtml(channel.name)}</span>`}
      ${state.user?.isSuperadmin && !showOwner ? `<label class="sidebar-available-all"><input type="checkbox" data-channel-available-all="${channel.id}"${state.sidebarAvailabilityDraft[channel.id] ? ' checked' : ''}> Visible to all</label>` : ''}
      ${canDeleteOrganizerChannel(channel, showOwner) ? `<button class="icon-btn sidebar-channel-delete" type="button" data-organizer-delete-channel="${channel.id}" title="Delete channel" aria-label="Delete #${escapeHtml(channel.name)}">&times;</button>` : ''}
    </div>`;
  const sectionChannels = (section, movable) => section.channelIds
    .map((id) => channelById.get(Number(id))).filter(Boolean).map((channel) => channelCard(channel, movable)).join('');

  const workspaceEditor = document.getElementById('workspace-sidebar-editor');
  workspaceEditor.classList.toggle('read-only', !canManageWorkspace);
  document.getElementById('btn-add-workspace-sidebar-section').hidden = !canManageWorkspace;
  document.getElementById('workspace-sidebar-readonly-note').hidden = canManageWorkspace;
  document.getElementById('workspace-sidebar-sections').innerHTML = workspaceDraft.sections.length
    ? workspaceDraft.sections.map((section, index) => `
      <div class="sidebar-section-card workspace" data-workspace-section-index="${index}">
        <div class="sidebar-section-card-head">
          <span class="sidebar-drag-handle" ${canManageWorkspace ? 'draggable="true"' : ''} title="${canManageWorkspace ? 'Drag to reorder' : 'Workspace section'}" aria-label="${canManageWorkspace ? 'Drag to reorder' : 'Workspace section'}">⋮⋮</span>
          ${canManageWorkspace
    ? `<input type="text" maxlength="40" value="${escapeHtml(section.name)}" data-workspace-section-name aria-label="Workspace section name">`
    : `<span class="sidebar-section-name-readonly">${escapeHtml(section.name)}</span>`}
          ${canManageWorkspace ? '<button class="icon-btn sidebar-section-add" type="button" data-add-channel-to-section title="Add a channel to this section" aria-label="Add channel">+</button><button class="btn danger-text" type="button" data-workspace-section-delete>Delete</button>' : '<span class="sidebar-section-badge">Workspace</span>'}
        </div>
        <div class="sidebar-section-dropzone" data-drop-scope="workspace" data-drop-section-id="${escapeHtml(section.id)}">
          ${sectionChannels(section, canManageWorkspace) || '<p class="sidebar-drop-hint">Drop channels here</p>'}
        </div>
      </div>`).join('')
    : '<p class="form-note">No workspace sections yet.</p>';

  document.getElementById('sidebar-sections').innerHTML = draft.sections.length
    ? draft.sections.map((section, index) => `
      <div class="sidebar-section-card personal" data-section-index="${index}">
        <div class="sidebar-section-card-head">
          <span class="sidebar-drag-handle" draggable="true" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
          <input type="text" maxlength="40" value="${escapeHtml(section.name)}" data-section-name aria-label="Section name">
          <button class="icon-btn sidebar-section-add" type="button" data-add-channel-to-section title="Add a channel to this section" aria-label="Add channel">+</button><button class="icon-btn sidebar-section-delete" type="button" data-section-delete title="Delete section" aria-label="Delete section">&times;</button>
        </div>
        <div class="sidebar-section-dropzone" data-drop-scope="personal" data-drop-section-id="${escapeHtml(section.id)}">
          ${sectionChannels(section, true) || '<p class="sidebar-drop-hint">Drop channels here</p>'}
        </div>
      </div>`).join('')
    : '<p class="form-note">No personal sections yet.</p>';

  const placed = new Set([...workspaceDraft.sections, ...draft.sections].flatMap((section) => section.channelIds.map(Number)));
  const unassigned = state.channels.filter((channel) => !placed.has(Number(channel.id)) && (Number(channel.createdBy) === Number(state.user?.id) || channel.availableToAll));
  const otherPersonal = state.channels.filter((channel) => !placed.has(Number(channel.id)) && Number(channel.createdBy) !== Number(state.user?.id) && !channel.availableToAll);
  document.getElementById('sidebar-channels').innerHTML = `
    <div class="sidebar-unassigned-dropzone" data-drop-unassigned>
      ${unassigned.map((channel) => channelCard(channel, true)).join('') || '<p class="sidebar-drop-hint">All channels are organized</p>'}
    </div>`;
  document.getElementById('sidebar-other-channels').innerHTML = `
    <div class="sidebar-unassigned-dropzone sidebar-other-personal-list">
      ${otherPersonal.map((channel) => channelCard(channel, false, true)).join('') || '<p class="sidebar-drop-hint">No personal channels from other owners</p>'}
    </div>`;
  if (typeof paintAvatarsIn === 'function') paintAvatarsIn(document.getElementById('modal-sidebar'));
  document.querySelectorAll('#modal-sidebar [data-organizer-owner]').forEach((avatar) => {
    const channel = channelById.get(Number(avatar.dataset.organizerOwner));
    if (!channel || typeof paintAvatar !== 'function') return;
    paintAvatar(avatar, { id: channel.createdBy, photoVersion: channel.creatorPhotoVersion }, creatorName(channel).charAt(0).toUpperCase());
  });
  setSidebarOrganizerTab(state.sidebarOrganizerTab);
}

function setSidebarOrganizerTab(tab) {
  const selected = ['workspace', 'mine', 'unassigned', 'others'].includes(tab) ? tab : 'workspace';
  state.sidebarOrganizerTab = selected;
  document.querySelectorAll('#modal-sidebar [data-sidebar-tab]').forEach((button) => {
    const active = button.dataset.sidebarTab === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('#modal-sidebar [data-sidebar-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.sidebarPanel !== selected;
  });
}

// Copies what is typed in the dialog back into the draft before re-rendering.
function syncSidebarDraft() {
  const draft = state.sidebarDraft;
  const workspaceDraft = state.workspaceSidebarDraft || { sections: [] };
  document.querySelectorAll('#sidebar-sections [data-section-index]').forEach((row) => {
    const section = draft.sections[Number(row.dataset.sectionIndex)];
    if (section) section.name = row.querySelector('[data-section-name]').value;
  });
  document.querySelectorAll('#workspace-sidebar-sections [data-workspace-section-index]').forEach((row) => {
    const section = workspaceDraft.sections[Number(row.dataset.workspaceSectionIndex)];
    const input = row.querySelector('[data-workspace-section-name]');
    if (section && input) section.name = input.value;
  });
  document.querySelectorAll('#modal-sidebar [data-channel-available-all]').forEach((input) => {
    state.sidebarAvailabilityDraft[input.dataset.channelAvailableAll] = input.checked;
  });
  document.querySelectorAll('#modal-sidebar [data-channel-name]').forEach((input) => {
    state.sidebarChannelNameDraft[input.dataset.channelName] = input.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  });
}

function moveSidebarDraftItem(kind, fromIndex, toIndex) {
  const sections = kind === 'workspace' ? state.workspaceSidebarDraft.sections : state.sidebarDraft.sections;
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex
      || fromIndex < 0 || toIndex < 0 || fromIndex >= sections.length || toIndex >= sections.length) return;
  const [section] = sections.splice(fromIndex, 1);
  sections.splice(toIndex, 0, section);
}

function assignSidebarDraftChannel(channelId, target) {
  [...state.sidebarDraft.sections, ...state.workspaceSidebarDraft.sections].forEach((section) => {
    section.channelIds = section.channelIds.filter((id) => Number(id) !== Number(channelId));
  });
  if (target) target.channelIds.push(Number(channelId));
}

function handleSidebarDragStart(event) {
  syncSidebarDraft();
  const workspaceRow = event.target.closest('[data-workspace-section-index]');
  const personalRow = event.target.closest('[data-section-index]');
  const channelRow = event.target.closest('[data-sidebar-channel-id]');
  const payload = channelRow
    ? { type: 'channel', id: Number(channelRow.dataset.sidebarChannelId) }
    : workspaceRow
      ? { type: 'section', kind: 'workspace', index: Number(workspaceRow.dataset.workspaceSectionIndex) }
    : personalRow
      ? { type: 'section', kind: 'personal', index: Number(personalRow.dataset.sectionIndex) }
      : null;
  if (!payload) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-itavenue-sidebar', JSON.stringify(payload));
  (channelRow || workspaceRow || personalRow).classList.add('dragging');
}

function handleSidebarDragOver(event) {
  const target = event.target.closest('[data-drop-section-id], [data-drop-unassigned], [data-workspace-section-index], [data-section-index]');
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  target.classList.add('drag-over');
}

function handleSidebarDrop(event) {
  const target = event.target.closest('[data-drop-section-id], [data-drop-unassigned], [data-workspace-section-index], [data-section-index]');
  if (!target) return;
  event.preventDefault();
  let payload;
  try { payload = JSON.parse(event.dataTransfer.getData('application/x-itavenue-sidebar')); } catch (_) { return; }
  if (payload.type === 'section') {
    const card = event.target.closest('[data-workspace-section-index], [data-section-index]');
    const kind = card?.hasAttribute('data-workspace-section-index') ? 'workspace'
      : card?.hasAttribute('data-section-index') ? 'personal' : null;
    if (kind !== payload.kind) return;
    const indexKey = kind === 'workspace' ? 'workspaceSectionIndex' : 'sectionIndex';
    moveSidebarDraftItem(kind, payload.index, Number(card.dataset[indexKey]));
  } else if (payload.type === 'channel') {
    const scope = target.dataset.dropScope;
    if (scope === 'workspace' && !state.sidebarDraft.canManageWorkspaceSections) return;
    const section = scope === 'workspace'
      ? state.workspaceSidebarDraft.sections.find((item) => item.id === target.dataset.dropSectionId)
      : scope === 'personal'
        ? state.sidebarDraft.sections.find((item) => item.id === target.dataset.dropSectionId) : null;
    assignSidebarDraftChannel(payload.id, section);
  }
  renderSidebarModal();
}

function clearSidebarDragState() {
  document.querySelectorAll('#modal-sidebar .dragging, #modal-sidebar .drag-over')
    .forEach((element) => element.classList.remove('dragging', 'drag-over'));
}

function handleSidebarModalClick(event) {
  const draft = state.sidebarDraft;
  const tab = event.target.closest('[data-sidebar-tab]');
  if (tab) { setSidebarOrganizerTab(tab.dataset.sidebarTab); return; }
  const addToSection = event.target.closest('[data-add-channel-to-section]');
  if (addToSection) {
    syncSidebarDraft();
    const workspaceRow = addToSection.closest('[data-workspace-section-index]');
    const personalRow = addToSection.closest('[data-section-index]');
    state.channelCreationSectionTarget = workspaceRow
      ? { kind: 'workspace', id: state.workspaceSidebarDraft.sections[Number(workspaceRow.dataset.workspaceSectionIndex)].id }
      : { kind: 'personal', id: draft.sections[Number(personalRow.dataset.sectionIndex)].id };
    openCreateChannelModal();
    return;
  }
  const deleteChannel = event.target.closest('[data-organizer-delete-channel]');
  if (deleteChannel) {
    deleteChannelFromOrganizer(Number(deleteChannel.dataset.organizerDeleteChannel));
    return;
  }
  if (event.target.closest('#btn-add-sidebar-section')) {
    syncSidebarDraft();
    if (draft.sections.length >= 20) { showToast('You can have at most 20 sections.', 'error'); return; }
    draft.sections.push({ id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: 'New section', channelIds: [], collapsed: false });
    renderSidebarModal();
    const inputs = document.querySelectorAll('#sidebar-sections [data-section-name]');
    inputs[inputs.length - 1]?.select();
    return;
  }
  if (event.target.closest('#btn-add-workspace-sidebar-section')) {
    syncSidebarDraft();
    const sections = state.workspaceSidebarDraft.sections;
    if (sections.length >= 20) { showToast('You can have at most 20 workspace sections.', 'error'); return; }
    sections.push({ id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: 'New workspace section', channelIds: [] });
    renderSidebarModal();
    const inputs = document.querySelectorAll('#workspace-sidebar-sections [data-workspace-section-name]');
    inputs[inputs.length - 1]?.select();
    return;
  }
  const workspaceRow = event.target.closest('[data-workspace-section-index]');
  if (workspaceRow) {
    if (event.target.closest('[data-workspace-section-delete]')) {
      syncSidebarDraft();
      state.workspaceSidebarDraft.sections.splice(Number(workspaceRow.dataset.workspaceSectionIndex), 1);
      renderSidebarModal();
    }
    return;
  }
  const row = event.target.closest('[data-section-index]');
  if (!row) return;
  const index = Number(row.dataset.sectionIndex);
  if (event.target.closest('[data-section-delete]')) {
    syncSidebarDraft();
    draft.sections.splice(index, 1);
    renderSidebarModal();
  }
}

async function saveSidebarModal(event) {
  event.preventDefault();
  syncSidebarDraft();
  try {
    const renamed = state.channels.filter((channel) => state.sidebarChannelNameDraft[channel.id]
      && state.sidebarChannelNameDraft[channel.id] !== channel.name);
    for (const channel of renamed) {
      const name = state.sidebarChannelNameDraft[channel.id];
      const response = await api(`/api/channels/${channel.id}/name`, { method: 'PATCH', body: JSON.stringify({ name }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Could not rename #${channel.name}`);
      channel.name = data.channel.name;
    }
    if (state.user?.isSuperadmin) {
      const changed = state.channels.filter((channel) => Boolean(channel.availableToAll) !== Boolean(state.sidebarAvailabilityDraft[channel.id]));
      for (const channel of changed) {
        const availableToAll = Boolean(state.sidebarAvailabilityDraft[channel.id]);
        const response = await api(`/api/channels/${channel.id}/availability`, { method: 'PATCH', body: JSON.stringify({ availableToAll }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Could not update #${channel.name}`);
        channel.availableToAll = availableToAll;
      }
    }
    if (state.sidebarDraft.canManageWorkspaceSections) {
      const workspaceRes = await api('/api/settings/sidebar/workspace', { method: 'PUT', body: JSON.stringify({ layout: state.workspaceSidebarDraft }) });
      const workspaceData = await workspaceRes.json();
      if (!workspaceRes.ok) throw new Error(workspaceData.error || 'Could not save workspace sections');
      state.sidebarDraft.workspaceSections = workspaceData.layout.sections;
    }
    await saveSidebarLayout(state.sidebarDraft);
    closeSettingsModal();
    showToast('Channel organizer saved.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not save your sidebar sections.', 'error');
  }
}

async function deleteChannelFromOrganizer(channelId) {
  const channel = state.channels.find((item) => Number(item.id) === Number(channelId));
  if (!channel) return;
  if (!(await confirmAction({ title: `Delete #${channel.name}?`, message: 'Its messages, files, canvas, lists, and links will be deleted for everyone.', confirmLabel: 'Delete channel', danger: true }))) return;
  try {
    const response = await api(`/api/moderation/channels/${channelId}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not delete the channel');
    state.channels = state.channels.filter((item) => Number(item.id) !== Number(channelId));
    [...state.sidebarDraft.sections, ...state.workspaceSidebarDraft.sections].forEach((section) => {
      section.channelIds = section.channelIds.filter((id) => Number(id) !== Number(channelId));
    });
    renderSidebarModal();
    renderSidebar();
    showToast(`#${channel.name} deleted.`, 'success');
  } catch (err) { showToast(err.message || 'Could not delete the channel.', 'error'); }
}

// ============================================================
// Channel resource tabs
// ============================================================
const CHANNEL_TABS = [
  ['messages', 'Messages'],
  ['pins', 'Pins'],
  ['files', 'Files'],
  ['canvases', 'Canvases'],
  ['lists', 'Lists'],
  ['links', 'Links'],
];

function channelTabState() {
  if (!state.channelTab) state.channelTab = { tab: 'messages', requestId: 0 };
  return state.channelTab;
}

function renderChannelTabs() {
  const tabs = document.getElementById('channel-tabs');
  if (!tabs) return;
  const current = channelTabState().tab;
  tabs.innerHTML = CHANNEL_TABS.map(([key, label]) => `<button type="button" class="channel-tab${current === key ? ' active' : ''}" role="tab" aria-selected="${current === key}" data-channel-tab="${key}">${label}</button>`).join('');
}

// Called when a channel is opened: always start on the conversation.
function resetChannelTab() {
  channelTabState().tab = 'messages';
  applyChannelTab();
}

function applyChannelTab() {
  const tab = channelTabState().tab;
  const view = document.getElementById('view-channel');
  const panel = document.getElementById('channel-resources');
  if (!view || !panel) return;
  view.classList.toggle('showing-resources', tab !== 'messages');
  panel.hidden = tab === 'messages';
  renderChannelTabs();
}

async function selectChannelTab(tab) {
  const tabState = channelTabState();
  tabState.tab = tab;
  applyChannelTab();
  if (tab === 'messages') return;
  const channelId = state.currentChannelId;
  const panel = document.getElementById('channel-resources');
  const requestId = ++tabState.requestId;
  panel.innerHTML = '<div class="loading-state">Loading…</div>';
  try {
    const html = await channelResourceHtml(tab, channelId);
    if (requestId !== tabState.requestId || Number(state.currentChannelId) !== Number(channelId)) return;
    panel.innerHTML = html;
  } catch (err) {
    console.error('Load channel resources error:', err);
    if (requestId === tabState.requestId) {
      panel.innerHTML = emptyRecordMarkup('Could not load this tab', err.message || 'Please try again.');
    }
  }
}

async function fetchJson(path) {
  const res = await api(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function channelResourceHtml(tab, channelId) {
  const row = (attrs, title, meta, actions = '') => `
    <div class="later-item" ${attrs}>
      <span class="later-item-body">
        <span class="later-item-title"><strong>${title}</strong></span>
        <span class="later-item-text">${meta}</span>
      </span>${actions}
    </div>`;

  if (tab === 'pins') {
    await loadPinnedMessages(channelId);
    const pins = state.pinnedMessages[channelId] || [];
    return pins.length
      ? pins.map((pin) => row(`data-resource-message="${pin.id}"`, escapeHtml(pin.username || 'Unknown'), escapeHtml(pin.content || 'Attachment'))).join('')
      : emptyRecordMarkup('No pinned messages', 'Pin a message to keep it handy for everyone in the channel.');
  }
  if (tab === 'files') {
    const data = await fetchJson('/api/files');
    const files = (data.files || []).filter((file) => Number(file.channelId) === Number(channelId));
    state.channelTab.files = files;
    return files.length
      ? files.map((file) => row(`data-resource-file="${file.id}"`, escapeHtml(file.name), `${escapeHtml(humanSize(file.size))} · shared by ${escapeHtml(file.uploaderUsername || 'former user')} · ${escapeHtml(shortTime(file.uploadedAt))}`, '<button class="btn" type="button">Download</button>')).join('')
      : emptyRecordMarkup('No files in this channel', 'Files attached to messages here will be listed.');
  }
  if (tab === 'canvases') {
    const data = await fetchJson(`/api/canvases?channelId=${channelId}`);
    const canvases = data.canvases || [];
    return canvases.length
      ? canvases.map((canvas) => {
        const owner = canvas.shared && canvas.owner;
        const ownerName = owner && (owner.name || owner.username || 'former user');
        const ownerHtml = owner ? `<span class="canvas-owner" title="${escapeHtml(ownerName)}">
          <span class="read-receipt-avatar canvas-owner-avatar" data-user-id="${owner.id}" role="button" tabindex="0" title="${escapeHtml(ownerName)}" aria-label="View ${escapeHtml(ownerName)}'s profile" style="background:${escapeHtml(owner.avatarColor || '#64748b')}">${escapeHtml(ownerName.charAt(0).toUpperCase())}</span>
          <span class="canvas-owner-label">Owned by ${escapeHtml(ownerName)}</span>
        </span>` : '';
        const meta = canvas.shared
          ? `<span class="canvas-meta"><span>Shared canvas</span>${ownerHtml}<span class="canvas-meta-separator">·</span><span>Updated ${escapeHtml(shortTime(canvas.updatedAt))}</span></span>`
          : `Updated ${escapeHtml(shortTime(canvas.updatedAt))}`;
        return row(`${canvas.shared ? 'data-resource-shared-canvas' : 'data-resource-canvas'}="${canvas.id}"`, escapeHtml(canvas.title || 'Untitled canvas'), meta);
      }).join('')
      : emptyRecordMarkup('No canvases in this channel', 'Create one from the Canvas section.');
  }
  if (tab === 'lists') {
    const data = await fetchJson(`/api/lists?channelId=${channelId}`);
    const lists = data.lists || [];
    return lists.length
      ? lists.map((list) => {
        const done = (list.items || []).filter((item) => item.completed).length;
        return row('data-resource-list="1"', escapeHtml(list.title), `${done} of ${(list.items || []).length} complete`);
      }).join('')
      : emptyRecordMarkup('No lists in this channel', 'Create one from the Lists section.');
  }
  // links
  const data = await fetchJson(`/api/channels/${channelId}/links`);
  const links = data.links || [];
  const canRemove = (link) => Number(link.createdBy) === Number(state.user.id) || canModerateChannel(channelId);
  return `
    <form class="channel-link-form" id="channel-link-form">
      <input type="text" name="title" maxlength="120" placeholder="Title (optional)" aria-label="Link title">
      <input type="url" name="url" maxlength="2000" placeholder="https://…" required aria-label="Web address">
      <button class="btn primary" type="submit">Add link</button>
    </form>
    ${links.length
    ? links.map((link) => row('', `<a class="message-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.title)}</a>`, `${escapeHtml(link.url)} · added by ${escapeHtml(link.createdByUsername)}`, canRemove(link) ? `<button class="btn" type="button" data-remove-link="${link.id}">Remove</button>` : '')).join('')
    : emptyRecordMarkup('No links yet', 'Add web addresses the whole channel should have at hand.')}`;
}

async function handleChannelResourceClick(event) {
  const channelId = state.currentChannelId;
  const removeLink = event.target.closest('[data-remove-link]');
  if (removeLink) {
    try {
      const res = await api(`/api/channels/${channelId}/links/${removeLink.dataset.removeLink}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not remove the link');
      await selectChannelTab('links');
    } catch (err) {
      showToast(err.message || 'Could not remove the link.', 'error');
    }
    return;
  }
  if (event.target.closest('a')) return;
  const message = event.target.closest('[data-resource-message]');
  if (message) {
    await selectChannelTab('messages');
    await scrollToMessage(message.dataset.resourceMessage);
    return;
  }
  const file = event.target.closest('[data-resource-file]');
  if (file) {
    const item = (state.channelTab.files || []).find((entry) => String(entry.id) === file.dataset.resourceFile);
    if (item) downloadFile(item.id, item.name);
    return;
  }
  const sharedCanvas = event.target.closest('[data-resource-shared-canvas]');
  if (sharedCanvas) {
    // a canvas from the Canvas section that was shared into this channel opens there
    await setSection('canvas2');
    await openCanvas2Standalone(sharedCanvas.dataset.resourceSharedCanvas);
    return;
  }
  const canvas = event.target.closest('[data-resource-canvas]');
  if (canvas) {
    await setSection('canvases');
    els.canvasChannelSelect.value = String(channelId);
    await handleCanvasChannelChange();
    await openCanvas(canvas.dataset.resourceCanvas, false);
    return;
  }
  if (event.target.closest('[data-resource-list]')) {
    await setSection('lists');
    els.listsChannelSelect.value = String(channelId);
    await loadLists();
  }
}

async function handleChannelLinkSubmit(event) {
  const form = event.target.closest('#channel-link-form');
  if (!form) return;
  event.preventDefault();
  try {
    const res = await api(`/api/channels/${state.currentChannelId}/links`, {
      method: 'POST',
      body: JSON.stringify({ title: form.elements.title.value, url: form.elements.url.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add the link');
    await selectChannelTab('links');
  } catch (err) {
    showToast(err.message || 'Could not add the link.', 'error');
  }
}

function handleChannelLinksUpdated({ channelId }) {
  if (Number(channelId) === Number(state.currentChannelId) && channelTabState().tab === 'links'
    && !document.querySelector('#channel-link-form input:focus')) {
    selectChannelTab('links');
  }
}

function setupWorkspaceFeatures() {
  document.getElementById('btn-schedule')?.addEventListener('click', () => openScheduleModal('channel'));
  document.getElementById('btn-dm-schedule')?.addEventListener('click', () => openScheduleModal('dm'));
  document.getElementById('schedule-form')?.addEventListener('submit', saveScheduledMessage);
  document.getElementById('schedule-when')?.addEventListener('change', (event) => {
    document.getElementById('schedule-custom-row').hidden = event.target.value !== 'custom';
  });
  ['btn-cancel-schedule', 'btn-close-schedule', 'btn-cancel-sidebar', 'btn-close-sidebar'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', closeSettingsModal);
  });

  document.getElementById('btn-organize-sidebar')?.addEventListener('click', (event) => {
    event.stopPropagation();
    openSidebarModal();
  });
  document.getElementById('modal-sidebar')?.addEventListener('click', handleSidebarModalClick);
  document.getElementById('modal-sidebar')?.addEventListener('dragstart', handleSidebarDragStart);
  document.getElementById('modal-sidebar')?.addEventListener('dragover', handleSidebarDragOver);
  document.getElementById('modal-sidebar')?.addEventListener('drop', handleSidebarDrop);
  document.getElementById('modal-sidebar')?.addEventListener('dragend', clearSidebarDragState);
  document.getElementById('modal-sidebar')?.addEventListener('dragleave', (event) => event.target.closest('.drag-over')?.classList.remove('drag-over'));
  document.getElementById('sidebar-form')?.addEventListener('submit', saveSidebarModal);
  els.channelList?.addEventListener('click', (event) => {
    const label = event.target.closest('[data-section-id]');
    if (label) { event.stopPropagation(); toggleSidebarSection(label.dataset.sectionId); }
  });

  document.getElementById('channel-tabs')?.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-channel-tab]');
    if (tab) selectChannelTab(tab.dataset.channelTab);
  });
  const resources = document.getElementById('channel-resources');
  resources?.addEventListener('click', handleChannelResourceClick);
  resources?.addEventListener('submit', handleChannelLinkSubmit);
  renderChannelTabs();
}
