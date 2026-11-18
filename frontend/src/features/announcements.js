// IT Avenue Workspace - the "Post announcement" dialog. Pure markup and rules at the top (tested); the part that opens the dialog,
// keeps the preview in step and posts is at the bottom and runs only in the app. The dialog replaces typing /announce: it only
// appears in an announcement channel for people who have the Announce permission, and posting from it needs no second confirmation.

const ANNOUNCEMENT_MAX = 2000;

function announcementEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function announcementDraftValid(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  return Boolean(value) && String(text).length <= ANNOUNCEMENT_MAX;
}

function announcementCounterText(text) {
  return `${String(text || '').length} / ${ANNOUNCEMENT_MAX}`;
}

function announcementDialogHtml({ text = '', channelName = '' } = {}) {
  const shown = String(text);
  return `<div class="modal open announce-modal" role="dialog" aria-modal="true" aria-label="Post announcement"><div class="modal-header"><h3>Post announcement</h3><button class="modal-close" type="button" data-announce-cancel aria-label="Close">&times;</button></div><div class="modal-body"><p class="announce-where">This is posted to <strong>#${announcementEscape(channelName)}</strong> and everyone in the channel sees it.</p><label class="poll-field-label" for="announce-text">Announcement</label><textarea id="announce-text" class="poll-field announce-text" data-announce-text rows="6" maxlength="${ANNOUNCEMENT_MAX}" placeholder="Write your announcement...">${announcementEscape(shown)}</textarea><div class="announce-count" data-announce-count>${announcementCounterText(shown)}</div><div class="poll-field-label">Preview</div><div class="announce-preview"><span class="message-announcement-badge">&#128227; Announcement</span><div class="announce-preview-text" data-announce-preview>${announcementEscape(shown)}</div></div></div><div class="modal-footer"><button type="button" class="btn" data-announce-cancel>Cancel</button><button type="button" class="btn primary" data-announce-post${announcementDraftValid(shown) ? '' : ' disabled'}>Post announcement</button></div></div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { announcementDialogHtml, announcementDraftValid, announcementCounterText, ANNOUNCEMENT_MAX };
}

// ---- everything below touches the page and the network; it is exercised in the browser, not in node ----

const announcementState = { busy: false };

// Shows the composer's megaphone button only where the person may announce (the channel's command list says so).
async function syncAnnouncementButton() {
  const button = document.getElementById('btn-add-announcement');
  if (!button) return;
  button.hidden = true;
  if (!state.currentChannelId) return;
  const channelId = Number(state.currentChannelId);
  await loadCommandsForChannel();
  if (Number(state.currentChannelId) !== channelId) return; // the person moved on while it loaded
  button.hidden = !(state.commands.items || []).some((item) => item.name === 'announce');
}

function updateAnnouncementDialog() {
  const overlay = document.getElementById('announce-dialog-overlay');
  if (!overlay) return;
  const text = overlay.querySelector('[data-announce-text]').value;
  overlay.querySelector('[data-announce-count]').textContent = announcementCounterText(text);
  const preview = overlay.querySelector('[data-announce-preview]');
  preview.innerHTML = text.trim() ? formatMessageText(text) : '<span class="announce-preview-empty">Your announcement will look like this.</span>';
  overlay.querySelector('[data-announce-post]').disabled = !announcementDraftValid(text) || announcementState.busy;
}

function closeAnnouncementDialog() {
  document.getElementById('announce-dialog-overlay')?.remove();
  announcementState.busy = false;
}

async function postAnnouncement() {
  const overlay = document.getElementById('announce-dialog-overlay');
  if (!overlay || announcementState.busy) return;
  const text = overlay.querySelector('[data-announce-text]').value;
  if (!announcementDraftValid(text)) return;
  announcementState.busy = true;
  updateAnnouncementDialog();
  try {
    const response = await api('/api/announcements', { method: 'POST', body: JSON.stringify({ channelId: Number(state.currentChannelId), text }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not post the announcement.');
    closeAnnouncementDialog();
    showToast('Announcement posted.', 'success');
  } catch (err) {
    announcementState.busy = false;
    updateAnnouncementDialog();
    showToast(err.message || 'Could not post the announcement.', 'error');
  }
}

function openAnnouncementDialog() {
  if (document.getElementById('announce-dialog-overlay')) return;
  const channel = (state.channels || []).find((candidate) => Number(candidate.id) === Number(state.currentChannelId));
  if (!channel) return;
  const overlay = document.createElement('div');
  overlay.id = 'announce-dialog-overlay';
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = announcementDialogHtml({ text: '', channelName: channel.name });
  document.body.appendChild(overlay);
  updateAnnouncementDialog();
  overlay.querySelector('[data-announce-text]').focus();
  overlay.addEventListener('input', (event) => { if (event.target.matches('[data-announce-text]')) updateAnnouncementDialog(); });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closeAnnouncementDialog(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); postAnnouncement(); }
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-announce-cancel]')) closeAnnouncementDialog();
    else if (event.target.closest('[data-announce-post]')) postAnnouncement();
  });
}

function setupAnnouncements() {
  document.addEventListener('click', (event) => { if (event.target.closest('#btn-add-announcement')) openAnnouncementDialog(); });
}
