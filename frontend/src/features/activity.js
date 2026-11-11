// IT Avenue Workspace - @mentions and the Activity feed.
//
// Loaded before renderer.js. This file only defines functions; renderer.js
// calls them once the app state exists (state, els, api, showToast, ...).

// ============================================================
// Mentions: detection and rendering
// ============================================================
function knownUsernames() {
  const names = (state.users || []).map((user) => user.username);
  if (state.user?.username) names.push(state.user.username);
  return names;
}

// Message HTML: safe rich text with @mentions highlighted (see format.js).
function formatMessageText(content) {
  return formatRichText(content, { usernames: knownUsernames(), me: state.user?.username || '' });
}

// ============================================================
// Mentions: composer autocomplete
// ============================================================
const mentionPicker = { open: false, items: [], index: 0, tokenStart: -1, requestId: 0 };

async function loadChannelMembers(channelId) {
  if (!channelId) return [];
  state.channelMembers = state.channelMembers || {};
  if (state.channelMembers[channelId]) return state.channelMembers[channelId];
  try {
    const res = await api(`/api/channels/${channelId}/members`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load channel members');
    state.channelMembers[channelId] = data.members || [];
  } catch (err) {
    console.error('Load channel members error:', err);
    return [];
  }
  return state.channelMembers[channelId];
}

function mentionPopup() {
  let popup = document.getElementById('mention-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'mention-popup';
    popup.className = 'mention-popup';
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-label', 'Mention a channel member');
    popup.hidden = true;
    popup.addEventListener('mousedown', (event) => {
      const option = event.target.closest('[data-mention-index]');
      if (!option) return;
      event.preventDefault();
      mentionPicker.index = Number(option.dataset.mentionIndex);
      applyMentionSelection();
    });
    els.messageInput.closest('.input-area').appendChild(popup);
  }
  return popup;
}

function closeMentionPicker() {
  mentionPicker.open = false;
  mentionPicker.items = [];
  const popup = document.getElementById('mention-popup');
  if (popup) popup.hidden = true;
}

function renderMentionPicker() {
  const popup = mentionPopup();
  popup.innerHTML = mentionPicker.items.map((member, index) => `
    <div class="mention-option${index === mentionPicker.index ? ' active' : ''}" role="option"
      aria-selected="${index === mentionPicker.index}" data-mention-index="${index}">
      <span class="avatar-mini" style="background:${escapeHtml(member.avatarColor || '#A855F7')};">${escapeHtml(member.username.charAt(0).toUpperCase())}</span>
      <span class="mention-option-name">${escapeHtml(member.username)}</span>
      ${member.role === 'moderator' ? '<span class="mention-option-role">moderator</span>' : ''}
    </div>`).join('');
  popup.hidden = false;
}

async function updateMentionPicker() {
  const input = els.messageInput;
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  if (!match || !state.currentChannelId) {
    closeMentionPicker();
    return;
  }
  const requestId = ++mentionPicker.requestId;
  const members = await loadChannelMembers(state.currentChannelId);
  if (requestId !== mentionPicker.requestId) return;

  const term = match[2].toLowerCase();
  const others = members.filter((member) => Number(member.id) !== Number(state.user.id));
  const starts = others.filter((member) => member.username.toLowerCase().startsWith(term));
  const contains = others.filter((member) => !starts.includes(member)
    && member.username.toLowerCase().includes(term));
  mentionPicker.items = [...starts, ...contains].slice(0, 8);
  if (!mentionPicker.items.length) {
    closeMentionPicker();
    return;
  }
  mentionPicker.open = true;
  mentionPicker.index = 0;
  mentionPicker.tokenStart = caret - match[2].length - 1;
  renderMentionPicker();
}

function applyMentionSelection() {
  const member = mentionPicker.items[mentionPicker.index];
  if (!member) return;
  const input = els.messageInput;
  const caret = input.selectionStart;
  const inserted = `@${member.username} `;
  input.value = input.value.slice(0, mentionPicker.tokenStart) + inserted + input.value.slice(caret);
  const position = mentionPicker.tokenStart + inserted.length;
  input.setSelectionRange(position, position);
  closeMentionPicker();
  input.focus();
}

// Runs in the capture phase so it sees keys before the Enter-to-send handler.
function handleMentionKeydown(event) {
  if (!mentionPicker.open) return;
  const count = mentionPicker.items.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    mentionPicker.index = (mentionPicker.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
    renderMentionPicker();
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    applyMentionSelection();
  } else if (event.key === 'Escape') {
    closeMentionPicker();
  } else {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
}

// ============================================================
// Activity feed
// ============================================================
const ACTIVITY_TABS = [
  ['all', 'All'],
  ['mention', 'Mentions'],
  ['reply', 'Replies'],
  ['reaction', 'Reactions'],
  ['unread', 'Unread channels'],
];

function activityState() {
  if (!state.activity) state.activity = { tab: 'all', items: [], unseenCount: 0, requestId: 0 };
  return state.activity;
}

function updateActivityBadge() {
  const badge = document.getElementById('activity-badge');
  if (!badge) return;
  const unreadMessages = state.channels.reduce((sum, channel) => sum + (channel.unreadCount || 0), 0);
  const total = unreadMessages + activityState().unseenCount;
  badge.hidden = total === 0;
  badge.textContent = total > 99 ? '99+' : String(total);
}

function activitySentence(item) {
  const actor = `<strong>${escapeHtml(item.actorUsername || 'Someone')}</strong>`;
  const channel = `<strong>#${escapeHtml(item.channelName || 'channel')}</strong>`;
  if (item.type === 'mention') return `${actor} mentioned you in ${channel}`;
  if (item.type === 'reply') return `${actor} replied to your message in ${channel}`;
  return `${actor} reacted ${escapeHtml(item.emoji || '')} to your message in ${channel}`;
}

function activityPlainSentence(item) {
  const actor = item.actorUsername || 'Someone';
  const channel = `#${item.channelName || 'channel'}`;
  if (item.type === 'mention') return `${actor} mentioned you in ${channel}`;
  if (item.type === 'reply') return `${actor} replied to your message in ${channel}`;
  return `${actor} reacted ${item.emoji || ''} to your message in ${channel}`;
}

function renderActivityTabs() {
  const tabs = document.getElementById('activity-tabs');
  if (!tabs) return;
  const activity = activityState();
  const unreadChannels = state.channels.filter((channel) => (channel.unreadCount || 0) > 0).length;
  tabs.innerHTML = ACTIVITY_TABS.map(([key, label]) => {
    const count = key === 'unread' ? unreadChannels : (key === 'all' ? activity.unseenCount : 0);
    return `<button type="button" class="activity-tab${activity.tab === key ? ' active' : ''}" role="tab"
      aria-selected="${activity.tab === key}" data-activity-tab="${key}">${label}${count ? `<span class="activity-tab-count">${count}</span>` : ''}</button>`;
  }).join('');
}

function renderActivityFeed() {
  const activity = activityState();
  const feed = document.getElementById('activity-feed');
  const grid = els.activityGrid;
  if (!feed || !grid) return;
  renderActivityTabs();

  const showUnread = activity.tab === 'unread';
  feed.hidden = showUnread;
  grid.hidden = !showUnread;
  if (showUnread) return;

  const items = activity.tab === 'all'
    ? activity.items
    : activity.items.filter((item) => item.type === activity.tab);
  feed.classList.toggle('has-empty-record', items.length === 0);
  if (!items.length) {
    const empty = {
      all: ['No activity yet', 'Mentions, replies, and reactions to your messages appear here.'],
      mention: ['No mentions yet', 'When someone types @ and your name, it shows up here.'],
      reply: ['No replies yet', 'Replies to your messages show up here.'],
      reaction: ['No reactions yet', 'Reactions to your messages show up here.'],
    }[activity.tab];
    feed.innerHTML = emptyRecordMarkup(empty[0], empty[1]);
    return;
  }
  feed.innerHTML = items.map((item, index) => `
    <button type="button" class="activity-item${item.unseen ? ' unseen' : ''}" data-activity-index="${activity.items.indexOf(item)}">
      <span class="avatar-mini" style="background:${escapeHtml(item.actorAvatarColor || '#A855F7')};">${escapeHtml((item.actorUsername || '?').charAt(0).toUpperCase())}</span>
      <span class="activity-item-body">
        <span class="activity-item-title">${activitySentence(item)}</span>
        <span class="activity-item-preview">${escapeHtml(item.preview || 'Attachment')}</span>
      </span>
      <span class="activity-item-time">${escapeHtml(shortTime(item.createdAt))}</span>
    </button>`).join('');
}

async function loadActivity({ markSeen = false } = {}) {
  const activity = activityState();
  const requestId = ++activity.requestId;
  try {
    const res = await api('/api/activity?limit=100');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load activity');
    if (requestId !== activity.requestId) return;
    activity.items = data.items || [];
    activity.unseenCount = data.unseenCount || 0;
    if (state.section === 'activity') renderActivityFeed();
    if (markSeen && activity.unseenCount > 0) {
      const seen = await api('/api/activity/seen', { method: 'POST' });
      if (seen.ok) activity.unseenCount = 0;
    }
  } catch (err) {
    console.error('Load activity error:', err);
    if (state.section === 'activity') showToast(err.message || 'Could not load activity.', 'error');
  }
  updateActivityBadge();
  if (state.section === 'activity') renderActivityTabs();
}

async function openActivityItem(item) {
  await openChannel(item.channelId);
  await scrollToMessage(item.messageId);
}

function handleActivityEvent(event) {
  const activity = activityState();
  const item = { ...event, unseen: true };
  activity.items.unshift(item);
  activity.items = activity.items.slice(0, 100);
  if (state.section === 'activity') {
    renderActivityFeed();
    api('/api/activity/seen', { method: 'POST' }).catch(() => {});
  } else {
    activity.unseenCount += 1;
  }
  updateActivityBadge();
  // Lets the channel-message notifier skip a message that was already announced here.
  recentlyNotifiedMessages().add(Number(event.messageId));
  notifyUser(event.type, activityPlainSentence(event), event);
}

function setupActivityFeatures() {
  if (els.messageInput) {
    els.messageInput.addEventListener('keydown', handleMentionKeydown, true);
    els.messageInput.addEventListener('input', () => { updateMentionPicker(); });
    els.messageInput.addEventListener('click', () => { updateMentionPicker(); });
    els.messageInput.addEventListener('blur', () => setTimeout(closeMentionPicker, 120));
  }
  document.getElementById('activity-tabs')?.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-activity-tab]');
    if (!tab) return;
    activityState().tab = tab.dataset.activityTab;
    renderActivityFeed();
  });
  document.getElementById('activity-feed')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-activity-index]');
    if (!row) return;
    const item = activityState().items[Number(row.dataset.activityIndex)];
    if (item) openActivityItem(item);
  });
}
