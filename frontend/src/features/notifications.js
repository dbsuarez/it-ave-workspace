// IT Avenue Workspace - notification preferences, Do Not Disturb, custom status,
// and live unread counts for channels that are not open.
//
// Loaded before renderer.js; defines functions only.

const NOTIFICATION_KINDS = {
  mention: 'mentions',
  reply: 'replies',
  reaction: 'reactions',
  dm: 'directMessages',
  channel: 'channelMessages',
};

const NOTIFICATION_LABELS = [
  ['mentions', 'Mentions of you'],
  ['directMessages', 'Direct and group messages'],
  ['replies', 'Replies to your messages'],
  ['reactions', 'Reactions to your messages'],
  ['channelMessages', 'Every new message in my channels'],
  ['desktop', 'Show a desktop notification when the app is in the background'],
  ['sound', 'Play a sound for notifications and incoming calls'],
];

const DND_CHOICES = [
  [0, 'Off'],
  [30, '30 minutes'],
  [60, '1 hour'],
  [240, '4 hours'],
  [1440, '24 hours'],
];

function userSettings() {
  if (!state.settings) {
    state.settings = {
      notifications: {
        mentions: true, directMessages: true, replies: true, reactions: true,
        channelMessages: false, desktop: true, sound: true,
      },
      dndUntil: null,
      statusText: '',
      statusEmoji: '',
    };
  }
  return state.settings;
}

function isDndActive() {
  const until = userSettings().dndUntil;
  return Boolean(until && new Date(until) > new Date());
}

// Single entry point for anything that wants the user's attention.
// Returns true when a notification was actually shown.
function notifyUser(kind, text, payload, options = {}) {
  const settings = userSettings();
  const key = NOTIFICATION_KINDS[kind];
  state.notificationLog = state.notificationLog || [];
  const entry = { kind, text, shown: false, reason: '' };
  state.notificationLog.push(entry);
  if (state.notificationLog.length > 50) state.notificationLog.shift();

  if (isDndActive()) { entry.reason = 'paused'; return false; }
  if (key && !settings.notifications[key]) { entry.reason = 'disabled'; return false; }

  showToast(text);
  entry.shown = true;
  if (options.sound !== false) entry.sound = playNotificationSound(kind);
  if (settings.notifications.desktop && !document.hasFocus() && typeof Notification === 'function') {
    try {
      // silent: the app plays its own sound (above), so the system does not add a second one
      const notification = new Notification('IT Avenue Workspace', { body: text, silent: true });
      notification.onclick = () => {
        window.focus();
        if ((payload?.channelId && payload?.messageId) || payload?.canvasId) openActivityItem(payload);
      };
      entry.desktop = true;
    } catch (err) {
      console.warn('Desktop notification failed:', err);
    }
  }
  return true;
}

async function loadUserSettings() {
  try {
    const res = await api('/api/settings');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load settings');
    state.settings = data.settings;
  } catch (err) {
    console.error('Load settings error:', err);
  }
  renderOwnStatus();
}

async function saveUserSettings(changes) {
  const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(changes) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not save settings');
  state.settings = data.settings;
  renderOwnStatus();
  return data.settings;
}

// ---- Preferences modal: notifications section ----
function fillNotificationSettingsForm() {
  const container = document.getElementById('notification-settings');
  if (!container) return;
  const settings = userSettings();
  const remaining = isDndActive()
    ? `Paused until ${new Date(settings.dndUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'Notifications are on';
  container.innerHTML = `
    ${NOTIFICATION_LABELS.map(([key, label]) => `
      <label class="preference-toggle">
        <input type="checkbox" data-notification-pref="${key}"${settings.notifications[key] ? ' checked' : ''}>
        <span>${label}</span>
      </label>`).join('')}
    ${soundPreferencesMarkup()}
    <div class="form-group notification-pause">
      <label for="notification-dnd">Pause notifications</label>
      <select id="notification-dnd">
        <option value="">Keep current (${escapeHtml(remaining)})</option>
        ${DND_CHOICES.map(([minutes, label]) => `<option value="${minutes}">${label}</option>`).join('')}
      </select>
    </div>`;
}

async function saveNotificationSettingsFromForm() {
  const container = document.getElementById('notification-settings');
  if (!container) return;
  const notifications = {};
  container.querySelectorAll('[data-notification-pref]').forEach((input) => {
    notifications[input.dataset.notificationPref] = input.checked;
  });
  const changes = { notifications };
  const dnd = document.getElementById('notification-dnd')?.value;
  if (dnd !== '' && dnd !== undefined) changes.dndMinutes = Number(dnd);
  await saveUserSettings(changes);
}

// ---- Custom status ----
function userStatusMarkup(user) {
  const emoji = user.statusEmoji ? `<span class="user-status-emoji" title="${escapeHtml(user.statusText || '')}">${escapeHtml(user.statusEmoji)}</span>` : '';
  const paused = user.dndUntil && new Date(user.dndUntil) > new Date()
    ? '<span class="user-dnd" title="Notifications paused">paused</span>' : '';
  const guest = user.accountType === 'guest' ? '<span class="user-dnd" title="Guest account">guest</span>' : '';
  return emoji + guest + paused;
}

function renderOwnStatus() {
  const settings = userSettings();
  const line = document.getElementById('user-status-line');
  if (line) {
    const parts = [];
    if (settings.statusEmoji || settings.statusText) parts.push(`${settings.statusEmoji} ${settings.statusText}`.trim());
    if (isDndActive()) parts.push('Notifications paused');
    line.textContent = parts.join(' · ');
    line.hidden = parts.length === 0;
  }
}

function openStatusModal() {
  const settings = userSettings();
  document.getElementById('status-emoji').value = settings.statusEmoji || '';
  document.getElementById('status-text').value = settings.statusText || '';
  openSettingsModal(document.getElementById('modal-status'));
}

async function saveStatus(event, clear = false) {
  event?.preventDefault();
  try {
    await saveUserSettings(clear
      ? { statusText: '', statusEmoji: '' }
      : {
        statusText: document.getElementById('status-text').value,
        statusEmoji: document.getElementById('status-emoji').value.trim(),
      });
    closeSettingsModal();
    showToast(clear ? 'Status cleared.' : 'Status updated.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not update status.', 'error');
  }
}

function handleUserStatusUpdated(event) {
  if (Number(event.userId) === Number(state.user.id)) {
    Object.assign(userSettings(), {
      statusText: event.statusText, statusEmoji: event.statusEmoji, dndUntil: event.dndUntil,
    });
    renderOwnStatus();
    return;
  }
  const user = (state.users || []).find((item) => Number(item.id) === Number(event.userId));
  if (!user) return;
  user.statusText = event.statusText;
  user.statusEmoji = event.statusEmoji;
  user.dndUntil = event.dndUntil;
  renderDmList();
  if (Number(state.currentDMId) === Number(user.id) && state.view === 'dm' && !state.currentGroupId) {
    els.dmTopic.textContent = dmTopicText(user);
  }
}

function dmTopicText(user) {
  const status = `${user.statusEmoji || ''} ${user.statusText || ''}`.trim();
  return status || `Direct message with ${user.username}`;
}

// ---- Live unread counts and message notifications ----
function recentlyNotifiedMessages() {
  if (!state.recentActivityMessageIds) state.recentActivityMessageIds = new Set();
  return state.recentActivityMessageIds;
}

function isChannelOnScreen(channelId) {
  return Number(state.currentChannelId) === Number(channelId)
    && state.view === 'channel' && state.section === 'home';
}

// Sent to every other member when a channel gets a message, whether or not
// that channel is open here.
function handleChannelActivity(event) {
  if (isChannelOnScreen(event.channelId)) return;
  const channel = state.channels.find((item) => Number(item.id) === Number(event.channelId));
  if (!channel) return;
  channel.unreadCount = (channel.unreadCount || 0) + 1;
  renderSidebar();
  renderActivity();
  // A mention or reply for the same message already notified; do not repeat it.
  setTimeout(() => {
    if (recentlyNotifiedMessages().has(Number(event.messageId))) return;
    notifyUser('channel', `${event.username} in #${event.channelName}: ${event.preview || 'sent an attachment'}`, event);
  }, 200);
}

function handleDirectMessageNotification(dm) {
  if (Number(dm.senderId) === Number(state.user.id)) return;
  const onScreen = Number(state.currentDMId) === Number(dm.senderId)
    && state.view === 'dm' && state.section === 'dms' && document.hasFocus();
  if (onScreen) return;
  notifyUser('dm', `${dm.senderUsername}: ${dm.content || 'sent an attachment'}`);
}

function setupNotificationFeatures() {
  document.getElementById('status-form')?.addEventListener('submit', (event) => saveStatus(event));
  document.getElementById('btn-clear-status')?.addEventListener('click', () => saveStatus(null, true));
  document.getElementById('btn-cancel-status')?.addEventListener('click', closeSettingsModal);
  document.getElementById('btn-close-status')?.addEventListener('click', closeSettingsModal);
}
