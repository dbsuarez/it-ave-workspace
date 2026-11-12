// IT Avenue Workspace - sending files: several at once (up to 10 in one message) and drag and drop.
//
// Pick files with the paperclip, or drag them onto a channel or a direct message. Each file is uploaded, then ONE
// message carries all of them, with whatever is typed in the message box as its caption. Files that fail to upload
// are reported and the rest are still sent. Loaded before renderer.js; renderer.js calls setupFileSending().

const MAX_FILES_PER_MESSAGE = 10;
const UPLOADS_AT_A_TIME = 1; // one after another, so the files keep the order they were chosen in

// The first 10 files, and how many were left out (pure; covered by test/attachments-plan.test.js).
function planUpload(files, max = MAX_FILES_PER_MESSAGE) {
  const list = Array.from(files || []);
  return { files: list.slice(0, max), skipped: Math.max(0, list.length - max) };
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch(`${API_BASE}/api/messages/upload`, { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, name: file.name, error: data.error || 'Upload failed' };
    return { ok: true, name: file.name, fileId: data.fileId };
  } catch (err) {
    return { ok: false, name: file.name, error: 'Could not reach the server' };
  }
}

// Upload (a few at a time if UPLOADS_AT_A_TIME allows), keeping the order the files were chosen in.
async function uploadAll(files) {
  const results = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next;
      next += 1;
      results[index] = await uploadFile(files[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOADS_AT_A_TIME, files.length) }, worker));
  return results;
}

// kind: 'channel' or 'dm' (the conversation that is open). Returns true when a message was sent.
async function sendFilesTo(kind, fileList) {
  const plan = planUpload(fileList);
  if (!plan.files.length) return false;
  if (!state.socketAuthenticated) { showToast('Chat is reconnecting. Please try again in a moment.', 'error'); return false; }
  if (kind === 'channel' && !state.currentChannelId) return false;
  if (kind === 'dm' && !state.currentDMId) return false;
  if (plan.skipped) showToast(`Up to ${MAX_FILES_PER_MESSAGE} files go in one message. Sending the first ${MAX_FILES_PER_MESSAGE}.`, 'info');
  showToast(plan.files.length === 1 ? `Uploading ${plan.files[0].name}…` : `Uploading ${plan.files.length} files…`, 'info');

  const results = await uploadAll(plan.files);
  const sent = results.filter((r) => r.ok);
  results.filter((r) => !r.ok).slice(0, 3).forEach((r) => showToast(`${r.name}: ${r.error}`, 'error'));
  if (!sent.length) return false;

  const input = kind === 'channel' ? els.messageInput : document.getElementById('dm-message-input');
  const caption = input ? input.value.trim() : '';
  if (kind === 'channel') {
    state.socket.emit('send_message', {
      channelId: state.currentChannelId, content: caption, attachmentIds: sent.map((r) => r.fileId), replyTo: state.replyingTo?.id || null,
    });
    if (typeof cancelReply === 'function') cancelReply();
  } else {
    state.socket.emit('send_direct_message', { receiverId: state.currentDMId, content: caption, attachmentIds: sent.map((r) => r.fileId) });
  }
  if (input && caption) { input.value = ''; input.dispatchEvent(new Event('input')); }
  return true;
}

function filesFromEvent(event) {
  const dt = event.dataTransfer;
  return dt && dt.files ? Array.from(dt.files) : [];
}

const hasFiles = (event) => Boolean(event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files'));

// Drag and drop onto the open channel or direct message. Dropping a file anywhere else must not make the window
// navigate to it (what a desktop web view does by default), so that is stopped too.
function setupFileSending() {
  const zones = [['view-channel', 'channel'], ['view-dm', 'dm']];
  for (const [id, kind] of zones) {
    const zone = document.getElementById(id);
    if (!zone) continue;
    let depth = 0;
    zone.addEventListener('dragenter', (event) => { if (hasFiles(event)) { depth += 1; zone.classList.add('drop-active'); event.preventDefault(); } });
    zone.addEventListener('dragover', (event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
    zone.addEventListener('dragleave', (event) => { if (hasFiles(event)) { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('drop-active'); } });
    zone.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      zone.classList.remove('drop-active');
      sendFilesTo(kind, filesFromEvent(event));
    });
  }
  const refuse = (event) => { if (hasFiles(event)) event.preventDefault(); };
  document.addEventListener('dragover', refuse);
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event) || event.defaultPrevented) return;
    event.preventDefault();
    showToast('Drop files onto a channel or a direct message to send them.', 'info');
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planUpload, MAX_FILES_PER_MESSAGE };
}
