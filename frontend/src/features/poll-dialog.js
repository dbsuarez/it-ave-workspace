// IT Avenue Workspace - the "Create poll" dialog (Messenger style). The markup and the rules come from polls.js; this file keeps the
// draft, wires the clicks and sends it to POST /api/polls. The poll then arrives in the channel like any other message.
// Loaded before renderer.js, which calls setupPollDialog() once.

const pollDialogState = { draft: null, channelId: null, busy: false };

function pollDialogOverlay() { return document.getElementById('poll-dialog-overlay'); }

function renderPollDialog(focusSelector) {
  const overlay = pollDialogOverlay();
  if (!overlay || !pollDialogState.draft) return;
  overlay.innerHTML = pollDialogHtml(pollDialogState.draft);
  if (focusSelector) overlay.querySelector(focusSelector)?.focus();
}

function closePollDialog() {
  const overlay = pollDialogOverlay();
  if (overlay) overlay.remove();
  pollDialogState.draft = null;
  pollDialogState.busy = false;
}

// Opens the dialog to make a new poll in the open channel, or (given a draft from pollDraftFromPoll) to edit an existing one.
function openPollDialog(editDraft = null) {
  if (pollDialogOverlay()) return;
  if (!editDraft) {
    const channel = (state.channels || []).find((candidate) => Number(candidate.id) === Number(state.currentChannelId));
    if (!state.currentChannelId || !channel) { showToast('Open a channel to add a poll.', 'info'); return; }
    if (channel.kind === 'forum') { showToast('Polls are not available in forums.', 'info'); return; }
    pollDialogState.channelId = Number(state.currentChannelId);
  }
  pollDialogState.draft = editDraft || { question: '', options: ['', ''], multiple: false, anonymous: false, closes: '' };
  const overlay = document.createElement('div');
  overlay.id = 'poll-dialog-overlay';
  overlay.className = 'modal-overlay open';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', handlePollDialogClick);
  overlay.addEventListener('input', handlePollDialogInput);
  overlay.addEventListener('change', handlePollDialogInput);
  overlay.addEventListener('keydown', handlePollDialogKeydown);
  renderPollDialog('[data-poll-question]');
}

// Only the Create button changes while someone types, so the box they are typing in keeps its place.
// The poll maker's Edit button on a poll message: loads the poll as it is now and opens the dialog to change it.
async function openPollEditor(pollId) {
  try {
    const response = await api(`/api/polls/${Number(pollId)}`);
    const poll = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(poll.error || 'Could not open the poll.');
    if (poll.closed) { showToast('This poll is closed, so it cannot be edited.', 'info'); return; }
    openPollDialog(pollDraftFromPoll(poll));
  } catch (err) { showToast(err.message || 'Could not open the poll.', 'error'); }
}

function syncPollCreateButton() {
  const button = document.querySelector('#poll-dialog-overlay [data-poll-create]');
  if (button) button.disabled = !pollDraftValid(pollDialogState.draft) || pollDialogState.busy;
}

function handlePollDialogInput(event) {
  const draft = pollDialogState.draft;
  const target = event.target;
  if (!draft) return;
  if (target.matches('[data-poll-question]')) draft.question = target.value;
  else if (target.matches('[data-poll-option]')) draft.options[Number(target.dataset.pollOption)] = target.value;
  else if (target.matches('[data-poll-multiple]')) draft.multiple = target.checked;
  else if (target.matches('[data-poll-anonymous]')) draft.anonymous = target.checked;
  else if (target.matches('[data-poll-closes]')) draft.closes = target.value;
  else return;
  syncPollCreateButton();
}

function handlePollDialogKeydown(event) {
  const draft = pollDialogState.draft;
  if (!draft) return;
  if (event.key === 'Escape') { event.stopPropagation(); closePollDialog(); return; }
  if (event.key !== 'Enter') return;
  const option = event.target.closest && event.target.closest('[data-poll-option]');
  if (event.target.matches && event.target.matches('[data-poll-question]')) { event.preventDefault(); document.querySelector('#poll-dialog-overlay [data-poll-option="0"]')?.focus(); return; }
  if (!option) return;
  event.preventDefault();
  const index = Number(option.dataset.pollOption);
  if (index === draft.options.length - 1 && draft.options.length < POLL_MAX_OPTIONS && option.value.trim()) {
    addPollOption(draft);
    renderPollDialog(`[data-poll-option="${draft.options.length - 1}"]`);
  } else {
    document.querySelector(`#poll-dialog-overlay [data-poll-option="${index + 1}"]`)?.focus();
  }
}

// Keeps the lists that go with the options (ids and vote counts when editing) the same length.
function addPollOption(draft) {
  draft.options.push('');
  if (draft.optionIds) draft.optionIds.push(null);
  if (draft.optionVotes) draft.optionVotes.push(0);
}

async function submitPoll() {
  const draft = pollDialogState.draft;
  if (!draft || pollDialogState.busy || !pollDraftValid(draft)) return;
  pollDialogState.busy = true;
  syncPollCreateButton();
  try {
    const editing = Boolean(draft.pollId);
    const response = editing
      ? await api(`/api/polls/${draft.pollId}`, { method: 'PUT', body: JSON.stringify(pollEditRequest(draft)) })
      : await api('/api/polls', { method: 'POST', body: JSON.stringify(pollDraftRequest(draft, pollDialogState.channelId)) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || (editing ? 'Could not save the poll.' : 'Could not create the poll.'));
    closePollDialog();
    if (editing) {
      refreshPollCard(draft.pollId);
      showToast('Poll updated.', 'success');
    }
  } catch (err) {
    pollDialogState.busy = false;
    syncPollCreateButton();
    showToast(err.message || 'Could not save the poll.', 'error');
  }
}

function handlePollDialogClick(event) {
  const draft = pollDialogState.draft;
  const target = event.target;
  if (!draft) return;
  if (target === pollDialogOverlay() || target.closest('[data-poll-cancel]')) { closePollDialog(); return; }
  if (target.closest('[data-poll-add-option]')) {
    if (draft.options.length < POLL_MAX_OPTIONS) { addPollOption(draft); renderPollDialog(`[data-poll-option="${draft.options.length - 1}"]`); }
    return;
  }
  const remove = target.closest('[data-poll-remove-option]');
  if (remove && draft.options.length > POLL_MIN_OPTIONS) {
    const index = Number(remove.dataset.pollRemoveOption);
    draft.options.splice(index, 1);
    if (draft.optionIds) draft.optionIds.splice(index, 1);
    if (draft.optionVotes) draft.optionVotes.splice(index, 1);
    renderPollDialog();
    return;
  }
  if (target.closest('[data-poll-create]')) submitPoll();
}

function setupPollDialog() {
  document.addEventListener('click', (event) => { if (event.target.closest('#btn-add-poll')) openPollDialog(); });
}
