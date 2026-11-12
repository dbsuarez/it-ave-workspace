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
  if (!state.sidebarLayout) state.sidebarLayout = { sections: [] };
  return state.sidebarLayout;
}

async function loadSidebarLayout() {
  try {
    const res = await api('/api/settings/sidebar');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load your sidebar sections');
    state.sidebarLayout = data.layout || { sections: [] };
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
  const sections = sidebarLayout().sections.filter((section) => Array.isArray(section.channelIds));
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
    label.setAttribute('aria-expanded', String(!section.collapsed));
    label.innerHTML = `<span class="nav-section-caret">${section.collapsed ? '▸' : '▾'}</span><span class="nav-section-name">${escapeHtml(section.name)}</span>${section.collapsed && unread ? `<span class="unread-badge">${unread}</span>` : ''}`;
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
  renderSidebarModal();
  openSettingsModal(document.getElementById('modal-sidebar'));
}

function renderSidebarModal() {
  const draft = state.sidebarDraft;
  const sectionOf = (channelId) => draft.sections.find((section) => section.channelIds.map(Number).includes(Number(channelId)))?.id || '';
  document.getElementById('sidebar-sections').innerHTML = draft.sections.length
    ? draft.sections.map((section, index) => `
      <div class="sidebar-section-row" data-section-index="${index}">
        <input type="text" maxlength="40" value="${escapeHtml(section.name)}" data-section-name aria-label="Section name">
        <button class="btn" type="button" data-section-move="-1" ${index === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="btn" type="button" data-section-move="1" ${index === draft.sections.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="btn" type="button" data-section-delete>Delete</button>
      </div>`).join('')
    : '<p class="form-note">No sections yet. Add one, then choose which channels go in it.</p>';
  document.getElementById('sidebar-channels').innerHTML = state.channels.map((channel) => `
    <label class="sidebar-channel-row">
      <span>#${escapeHtml(channel.name)}</span>
      <select data-channel-section="${channel.id}" aria-label="Section for #${escapeHtml(channel.name)}">
        <option value="">Channels (no section)</option>
        ${draft.sections.map((section) => `<option value="${escapeHtml(section.id)}"${sectionOf(channel.id) === section.id ? ' selected' : ''}>${escapeHtml(section.name || 'Untitled')}</option>`).join('')}
      </select>
    </label>`).join('');
}

// Copies what is typed in the dialog back into the draft before re-rendering.
function syncSidebarDraft() {
  const draft = state.sidebarDraft;
  document.querySelectorAll('#sidebar-sections [data-section-index]').forEach((row) => {
    const section = draft.sections[Number(row.dataset.sectionIndex)];
    if (section) section.name = row.querySelector('[data-section-name]').value;
  });
  draft.sections.forEach((section) => { section.channelIds = []; });
  document.querySelectorAll('#sidebar-channels [data-channel-section]').forEach((select) => {
    const section = draft.sections.find((item) => item.id === select.value);
    if (section) section.channelIds.push(Number(select.dataset.channelSection));
  });
}

function handleSidebarModalClick(event) {
  const draft = state.sidebarDraft;
  if (event.target.closest('#btn-add-sidebar-section')) {
    syncSidebarDraft();
    if (draft.sections.length >= 20) { showToast('You can have at most 20 sections.', 'error'); return; }
    draft.sections.push({ id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: 'New section', channelIds: [], collapsed: false });
    renderSidebarModal();
    const inputs = document.querySelectorAll('#sidebar-sections [data-section-name]');
    inputs[inputs.length - 1]?.select();
    return;
  }
  const row = event.target.closest('[data-section-index]');
  if (!row) return;
  const index = Number(row.dataset.sectionIndex);
  const move = event.target.closest('[data-section-move]');
  if (move) {
    syncSidebarDraft();
    const target = index + Number(move.dataset.sectionMove);
    if (target < 0 || target >= draft.sections.length) return;
    [draft.sections[index], draft.sections[target]] = [draft.sections[target], draft.sections[index]];
    renderSidebarModal();
  } else if (event.target.closest('[data-section-delete]')) {
    syncSidebarDraft();
    draft.sections.splice(index, 1);
    renderSidebarModal();
  }
}

async function saveSidebarModal(event) {
  event.preventDefault();
  syncSidebarDraft();
  try {
    await saveSidebarLayout(state.sidebarDraft);
    closeSettingsModal();
    showToast('Sidebar sections saved.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not save your sidebar sections.', 'error');
  }
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
      ? canvases.map((canvas) => row(`data-resource-canvas="${canvas.id}"`, escapeHtml(canvas.title), `Updated ${escapeHtml(shortTime(canvas.updatedAt))}`)).join('')
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
