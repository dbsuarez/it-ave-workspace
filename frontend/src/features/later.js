// IT Avenue Workspace - editing and deleting your own messages, saved items,
// and reminders (the "Later" view).
//
// Loaded before renderer.js; defines functions only.

function laterState() {
  if (!state.later) state.later = { tab: 'saved', saved: [], reminders: [], reminderMessageId: null };
  return state.later;
}

function savedItemForMessage(messageId) {
  return laterState().saved.find((item) => item.type === 'message' && Number(item.messageId) === Number(messageId));
}

function savedItemForFile(fileId) {
  return laterState().saved.find((item) => item.type === 'file' && Number(item.fileId) === Number(fileId));
}

// ============================================================
// Extra actions on channel messages (called from renderMessageEl)
// ============================================================
// The Save / Remind me / Edit / Delete buttons are rendered by
// renderer.js inside the per-message "More actions" menu (data-save-message,
// data-remind-message, ...). The click delegation below handles them.

function messageEditedHtml(msg) {
  if (!msg.editedAt || msg.pending) return '';
  return `<button class="message-edited" type="button" data-message-edits="${escapeHtml(String(msg.id))}" title="Edited ${escapeHtml(new Date(msg.editedAt).toLocaleString())}. Click to see earlier versions.">(edited)</button>`;
}

function findChannelMessage(messageId) {
  const messages = state.messages[state.currentChannelId] || [];
  return messages.find((message) => Number(message.id) === Number(messageId));
}

// ---- Edit ----
function startEditMessage(messageId) {
  const message = findChannelMessage(messageId);
  const el = document.getElementById(`message-${messageId}`);
  if (!message || !el || el.querySelector('.message-edit-form')) return;
  const textEl = el.querySelector('.message-text');
  const form = document.createElement('form');
  form.className = 'message-edit-form';
  form.innerHTML = `
    <textarea rows="2" maxlength="10000" aria-label="Edit message"></textarea>
    <div class="message-edit-buttons">
      <button class="btn" type="button" data-cancel-edit>Cancel</button>
      <button class="btn primary" type="submit">Save changes</button>
    </div>`;
  const textarea = form.querySelector('textarea');
  textarea.value = message.content;
  const cancel = () => { form.replaceWith(textEl); };
  form.querySelector('[data-cancel-edit]').addEventListener('click', cancel);
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = textarea.value.trim();
    if (!content) { showToast('A message cannot be empty. Delete it instead.', 'error'); return; }
    if (content === message.content) { cancel(); return; }
    try {
      const res = await api(`/api/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ content }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not edit the message');
      handleMessageUpdated(data.message);
    } catch (err) {
      showToast(err.message || 'Could not edit the message.', 'error');
    }
  });
  textEl.replaceWith(form);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function handleMessageUpdated(event) {
  const channelId = Number(event.channelId);
  const messages = state.messages[channelId] || [];
  const message = messages.find((item) => Number(item.id) === Number(event.messageId ?? event.id));
  if (message) {
    message.content = event.content;
    if (event.editedAt) message.editedAt = event.editedAt;
  }
  messages.forEach((item) => {
    if (Number(item.replyTo) === Number(event.messageId ?? event.id) && item.replyToMessage) {
      item.replyToMessage.content = event.content;
    }
  });
  if (Number(state.currentChannelId) === channelId && state.view === 'channel') {
    const container = document.getElementById('messages');
    const scrollTop = container.scrollTop;
    renderMessages('messages', messages);
    container.scrollTop = scrollTop;
  }
  (state.pinnedMessages[channelId] || []).forEach((item) => {
    if (Number(item.id) === Number(event.messageId ?? event.id)) item.content = event.content;
  });
  if (Number(state.currentChannelId) === channelId && state.pinPanelOpen) renderPinnedMessages(channelId);
}

async function showMessageEdits(messageId) {
  try {
    const res = await api(`/api/messages/${messageId}/edits`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load earlier versions');
    const rows = (data.edits || []).map((edit) => `
      <div class="info-row">
        <div class="info-row-meta">Before the edit on ${escapeHtml(new Date(edit.editedAt).toLocaleString())}</div>
        <div class="info-row-text">${escapeHtml(edit.previousContent)}</div>
      </div>`).join('');
    openInfoModal('Earlier versions', rows || '<p class="form-note">No earlier versions are stored for this message.</p>');
  } catch (err) {
    showToast(err.message || 'Could not load earlier versions.', 'error');
  }
}

function openInfoModal(title, html) {
  document.getElementById('info-modal-title').textContent = title;
  document.getElementById('info-modal-body').innerHTML = html;
  openSettingsModal(document.getElementById('modal-info'));
}

// ---- Delete own ----
async function deleteOwnMessage(messageId) {
  if (!confirm('Delete this message for everyone? This cannot be undone.')) return;
  try {
    const res = await api(`/api/messages/${messageId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete the message');
    showToast('Message deleted.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not delete the message.', 'error');
  }
}

// ============================================================
// Saved items
// ============================================================
async function loadSaved() {
  try {
    const res = await api('/api/saved');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load saved items');
    laterState().saved = data.items || [];
  } catch (err) {
    console.error('Load saved items error:', err);
  }
}

async function toggleSaved({ messageId, fileId }) {
  const existing = messageId ? savedItemForMessage(messageId) : savedItemForFile(fileId);
  try {
    if (existing) {
      const res = await api(`/api/saved/${existing.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not remove the saved item');
      showToast('Removed from saved items.', 'success');
    } else {
      const res = await api('/api/saved', {
        method: 'POST', body: JSON.stringify(messageId ? { messageId: Number(messageId) } : { fileId: Number(fileId) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save the item');
      showToast('Saved for later. Find it under Later.', 'success');
    }
    await loadSaved();
    if (state.view === 'channel' && state.currentChannelId) {
      const container = document.getElementById('messages');
      const scrollTop = container.scrollTop;
      renderMessages('messages', state.messages[state.currentChannelId] || []);
      container.scrollTop = scrollTop;
    }
    if (state.section === 'files') renderFiles(state.files || []);
    if (state.section === 'later') renderLaterView();
  } catch (err) {
    showToast(err.message || 'Could not update saved items.', 'error');
  }
}

// Adds a Save button to a channel file card (called from renderFiles).
function decorateFileCard(card, file) {
  if (!file.channelId) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-card-save';
  button.dataset.saveFile = String(file.id);
  button.textContent = savedItemForFile(file.id) ? 'Unsave' : 'Save';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSaved({ fileId: file.id });
  });
  card.appendChild(button);
}

// ============================================================
// Reminders
// ============================================================
const REMINDER_PRESETS = [
  ['20m', 'In 20 minutes'],
  ['1h', 'In 1 hour'],
  ['3h', 'In 3 hours'],
  ['tomorrow', 'Tomorrow at 9:00 AM'],
  ['custom', 'Pick a date and time'],
];

function reminderPresetTime(preset, now = new Date()) {
  const time = new Date(now);
  if (preset === '20m') time.setMinutes(time.getMinutes() + 20);
  else if (preset === '1h') time.setHours(time.getHours() + 1);
  else if (preset === '3h') time.setHours(time.getHours() + 3);
  else if (preset === 'tomorrow') { time.setDate(time.getDate() + 1); time.setHours(9, 0, 0, 0); }
  else return null;
  return time;
}

async function loadReminders() {
  try {
    const res = await api('/api/reminders');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load reminders');
    laterState().reminders = data.reminders || [];
  } catch (err) {
    console.error('Load reminders error:', err);
  }
  updateLaterBadge();
}

function openReminderModal(messageId) {
  const later = laterState();
  later.reminderMessageId = messageId || null;
  const message = messageId ? findChannelMessage(messageId) : null;
  document.getElementById('reminder-text').value = '';
  document.getElementById('reminder-text').placeholder = message
    ? 'Optional note (the message is linked)' : 'e.g. Send the weekly report';
  document.getElementById('reminder-message-preview').textContent = message ? `About: ${message.content.slice(0, 140)}` : '';
  document.getElementById('reminder-message-preview').hidden = !message;
  const select = document.getElementById('reminder-when');
  select.innerHTML = REMINDER_PRESETS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  document.getElementById('reminder-custom-row').hidden = true;
  document.getElementById('reminder-custom').value = '';
  openSettingsModal(document.getElementById('modal-reminder'));
}

async function saveReminder(event) {
  event.preventDefault();
  const later = laterState();
  const preset = document.getElementById('reminder-when').value;
  const custom = document.getElementById('reminder-custom').value;
  const when = preset === 'custom' ? (custom ? new Date(custom) : null) : reminderPresetTime(preset);
  if (!when || Number.isNaN(when.getTime())) { showToast('Pick a date and time.', 'error'); return; }
  try {
    const res = await api('/api/reminders', {
      method: 'POST',
      body: JSON.stringify({
        text: document.getElementById('reminder-text').value,
        remindAt: when.toISOString(),
        ...(later.reminderMessageId ? { messageId: Number(later.reminderMessageId) } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create the reminder');
    closeSettingsModal();
    showToast(`Reminder set for ${when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`, 'success');
    await loadReminders();
    if (state.section === 'later') renderLaterView();
  } catch (err) {
    showToast(err.message || 'Could not create the reminder.', 'error');
  }
}

function reminderSentence(reminder) {
  return reminder.text || reminder.messagePreview || 'Reminder';
}

// Reminders always get through: they are something the user asked for.
function handleReminderDue({ reminder }) {
  const later = laterState();
  const index = later.reminders.findIndex((item) => Number(item.id) === Number(reminder.id));
  if (index === -1) later.reminders.push(reminder); else later.reminders[index] = reminder;
  later.dueUnseen = (later.dueUnseen || 0) + 1;
  showToast(`Reminder: ${reminderSentence(reminder)}`);
  if (typeof playNotificationSound === 'function') playNotificationSound('reminder');
  if (!document.hasFocus() && typeof Notification === 'function') {
    try { new Notification('Reminder', { body: reminderSentence(reminder) }); } catch (err) { /* ignore */ }
  }
  updateLaterBadge();
  if (state.section === 'later') renderLaterView();
}

function updateLaterBadge() {
  const badge = document.getElementById('later-badge');
  if (!badge) return;
  const count = laterState().dueUnseen || 0;
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

// ============================================================
// Later view
// ============================================================
async function loadLaterView() {
  await Promise.all([loadSaved(), loadReminders(), loadScheduled()]);
  laterState().dueUnseen = 0;
  updateLaterBadge();
  renderLaterView();
}

function renderLaterView() {
  const later = laterState();
  const tabs = document.getElementById('later-tabs');
  const body = document.getElementById('later-body');
  if (!tabs || !body) return;
  const pending = later.reminders.filter((item) => !item.deliveredAt).length;
  const scheduledCount = scheduledState().items.length;
  tabs.innerHTML = [['saved', `Saved (${later.saved.length})`], ['reminders', `Reminders (${pending})`], ['scheduled', `Scheduled (${scheduledCount})`]]
    .map(([key, label]) => `<button type="button" class="activity-tab${later.tab === key ? ' active' : ''}" role="tab" aria-selected="${later.tab === key}" data-later-tab="${key}">${label}</button>`).join('');

  if (later.tab === 'saved') {
    body.classList.toggle('has-empty-record', later.saved.length === 0);
    body.innerHTML = later.saved.length ? later.saved.map((item) => (item.type === 'message' ? `
      <div class="later-item" data-open-saved="${item.id}">
        <span class="avatar-mini" style="background:${escapeHtml(item.avatarColor || '#A855F7')};" ${item.userId ? `data-user-id="${escapeHtml(String(item.userId))}" role="button" tabindex="0" title="View profile" aria-label="View profile"` : ''}>${escapeHtml((item.username || '?').charAt(0).toUpperCase())}</span>
        <span class="later-item-body">
          <span class="later-item-title"><strong>${escapeHtml(item.username)}</strong> in <strong>#${escapeHtml(item.channelName)}</strong></span>
          <span class="later-item-text">${escapeHtml(item.content || 'Attachment')}</span>
        </span>
        <button class="btn" type="button" data-remove-saved="${item.id}">Remove</button>
      </div>` : `
      <div class="later-item" data-open-saved="${item.id}">
        <span class="later-file-icon">${fileIconSvg(fileIcon(item.mimeType))}</span>
        <span class="later-item-body">
          <span class="later-item-title"><strong>${escapeHtml(item.name)}</strong> · ${escapeHtml(humanSize(item.size))}</span>
          <span class="later-item-text">File shared by ${escapeHtml(item.username)} in #${escapeHtml(item.channelName)}</span>
        </span>
        <button class="btn" type="button" data-download-saved="${item.id}">Download</button>
        <button class="btn" type="button" data-remove-saved="${item.id}">Remove</button>
      </div>`)).join('')
      : emptyRecordMarkup('Nothing saved yet', 'Use Save on a message or a file to keep it here. Only you can see this list.');
    return;
  }

  if (later.tab === 'scheduled') {
    body.classList.toggle('has-empty-record', scheduledCount === 0);
    body.innerHTML = scheduledListHtml();
    return;
  }

  body.classList.toggle('has-empty-record', later.reminders.length === 0);
  body.innerHTML = later.reminders.length ? later.reminders.map((item) => `
    <div class="later-item${item.deliveredAt ? ' done' : ''}"${item.messageId && item.channelId ? ` data-open-reminder="${item.id}"` : ''}>
      <span class="later-item-body">
        <span class="later-item-title"><strong>${escapeHtml(reminderSentence(item))}</strong></span>
        <span class="later-item-text">${item.deliveredAt ? 'Reminded' : 'Due'} ${escapeHtml(new Date(item.remindAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}${item.channelName ? ` · linked to a message in #${escapeHtml(item.channelName)}` : ''}</span>
      </span>
      <button class="btn" type="button" data-delete-reminder="${item.id}">${item.deliveredAt ? 'Clear' : 'Cancel'}</button>
    </div>`).join('')
    : emptyRecordMarkup('No reminders', 'Use "New reminder", or "Remind me" on a message.');
}

async function handleLaterClick(event) {
  const later = laterState();
  const tab = event.target.closest('[data-later-tab]');
  if (tab) { later.tab = tab.dataset.laterTab; renderLaterView(); return; }

  const remove = event.target.closest('[data-remove-saved]');
  if (remove) {
    const item = later.saved.find((entry) => Number(entry.id) === Number(remove.dataset.removeSaved));
    if (item) await toggleSaved(item.type === 'message' ? { messageId: item.messageId } : { fileId: item.fileId });
    return;
  }
  const download = event.target.closest('[data-download-saved]');
  if (download) {
    const item = later.saved.find((entry) => Number(entry.id) === Number(download.dataset.downloadSaved));
    if (item) downloadFile(item.fileId, item.name);
    return;
  }
  const cancelScheduled = event.target.closest('[data-cancel-scheduled]');
  if (cancelScheduled) { await cancelScheduledMessage(cancelScheduled.dataset.cancelScheduled); return; }
  const cancelReminder = event.target.closest('[data-delete-reminder]');
  if (cancelReminder) {
    try {
      const res = await api(`/api/reminders/${cancelReminder.dataset.deleteReminder}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not remove the reminder');
      await loadReminders();
      renderLaterView();
    } catch (err) {
      showToast(err.message || 'Could not remove the reminder.', 'error');
    }
    return;
  }
  const openSaved = event.target.closest('[data-open-saved]');
  if (openSaved) {
    const item = later.saved.find((entry) => Number(entry.id) === Number(openSaved.dataset.openSaved));
    if (item) openActivityItem({ channelId: item.channelId, messageId: item.messageId });
    return;
  }
  const openReminder = event.target.closest('[data-open-reminder]');
  if (openReminder) {
    const item = later.reminders.find((entry) => Number(entry.id) === Number(openReminder.dataset.openReminder));
    if (item) openActivityItem({ channelId: item.channelId, messageId: item.messageId });
  }
}

function handleMessageExtraClick(event) {
  const target = event.target.closest('[data-save-message],[data-remind-message],[data-edit-message],[data-delete-own-message],[data-message-edits]');
  if (!target) return;
  event.preventDefault();
  const data = target.dataset;
  if (data.saveMessage) toggleSaved({ messageId: data.saveMessage });
  else if (data.remindMessage) openReminderModal(data.remindMessage);
  else if (data.editMessage) startEditMessage(data.editMessage);
  else if (data.deleteOwnMessage) deleteOwnMessage(data.deleteOwnMessage);
  else if (data.messageEdits) showMessageEdits(data.messageEdits);
}

function setupLaterFeatures() {
  document.getElementById('messages')?.addEventListener('click', handleMessageExtraClick);
  document.getElementById('view-later')?.addEventListener('click', handleLaterClick);
  document.getElementById('btn-new-reminder')?.addEventListener('click', () => openReminderModal(null));
  document.getElementById('reminder-form')?.addEventListener('submit', saveReminder);
  document.getElementById('reminder-when')?.addEventListener('change', (event) => {
    document.getElementById('reminder-custom-row').hidden = event.target.value !== 'custom';
  });
  ['btn-cancel-reminder', 'btn-close-reminder', 'btn-close-info', 'btn-ok-info'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', closeSettingsModal);
  });
}
