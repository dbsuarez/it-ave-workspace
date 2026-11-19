// IT Avenue Workspace - polls: the interactive card shown for a message with kind 'poll', and the "Create poll" dialog.
//
// Pure functions: data in, HTML out, every value escaped. Voting, withdrawing and closing are handled by delegated click handlers
// in renderer.js, and the dialog's behaviour by poll-dialog.js; both read the data attributes written here. Loaded before them.
//
// The card's markup has no line breaks or indentation between tags on purpose: chat text keeps whitespace, so any would show as
// blank lines and make the poll tall.

function pollEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const POLL_AVATARS_SHOWN = 6;

// The voters of an ended poll as small round avatars (the same circles as "Seen by"), so a poll takes far less room than a line
// of names. `people(id)` may return { name, avatarColor } for a person the client knows; anyone else shows their username's
// first letter on the default colour. The photo (if they have one) is painted over the circle by the app's avatar painter.
function pollAvatarsHtml(option, people) {
  const ids = option.voterIds || [];
  const names = option.voters || [];
  const circles = ids.slice(0, POLL_AVATARS_SHOWN).map((id, index) => {
    const known = typeof people === 'function' ? people(Number(id)) : null;
    const name = String((known && known.name) || names[index] || 'User');
    const color = String((known && known.avatarColor) || '#A855F7');
    return `<span class="read-receipt-avatar" title="${pollEscape(name)}" style="background:${pollEscape(color)};" data-user-id="${Number(id)}" role="button" tabindex="0" aria-label="View ${pollEscape(name.trim())}'s profile">${pollEscape(name.charAt(0).toUpperCase())}</span>`;
  }).join('');
  const more = ids.length > POLL_AVATARS_SHOWN ? `<span class="poll-voters-more">+${ids.length - POLL_AVATARS_SHOWN}</span>` : '';
  return `<div class="poll-voter-avatars read-receipt-avatars">${circles}${more}</div>`;
}

function pollCardHtml(poll, { canClose = false, people = null } = {}) {
  const mine = new Set((poll.myOptionIds || []).map(Number));
  const total = Number(poll.totalVoters) || 0;
  const options = (poll.options || []).map((option) => {
    const id = Number(option.id);
    const count = Number(option.count) || 0;
    const percent = total ? Math.round((count / total) * 100) : 0;
    const selected = mine.has(id);
    const showAvatars = poll.closed && Array.isArray(option.voterIds) && option.voterIds.length;
    const voters = showAvatars ? pollAvatarsHtml(option, people)
      : (Array.isArray(option.voters) && option.voters.length ? `<small class="poll-voters">${option.voters.map((voter) => pollEscape(typeof displayName === 'function' ? displayName(voter) : voter)).join(', ')}</small>` : '');
    return `<div class="poll-row"><button type="button" class="poll-option${selected ? ' selected' : ''}" data-poll-vote="${id}" aria-pressed="${selected}"${poll.closed ? ' disabled' : ''}><span class="poll-bar" style="width:${percent}%"></span><span class="poll-label">${pollEscape(option.label)}</span><span class="poll-count">${count} (${percent}%)</span></button>${voters}</div>`;
  }).join('');
  const meta = [
    poll.multiple ? 'Pick any' : 'Pick one',
    poll.anonymous ? 'Anonymous' : 'Votes are visible',
    poll.closed ? 'Closed' : (poll.closesAt ? `Closes ${pollEscape(new Date(poll.closesAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}` : ''),
  ].filter(Boolean).join(' · ');
  const actions = !poll.closed
    ? `${mine.size ? '<button type="button" class="btn poll-action" data-poll-withdraw>Withdraw vote</button>' : ''}${canClose ? '<button type="button" class="btn poll-action" data-poll-close>Close poll</button>' : ''}`
    : '';
  return `<div class="poll-card" data-poll-id="${Number(poll.id)}" data-poll-multiple="${poll.multiple ? 1 : 0}" data-poll-mine="${[...mine].sort((a, b) => a - b).join(',')}" data-poll-can-close="${canClose ? 1 : 0}"><div class="poll-question">${pollEscape(poll.question)}</div><div class="poll-meta">${meta}</div><div class="poll-options">${options}</div><div class="poll-footer"><span>${total ? `${total} ${total === 1 ? 'person' : 'people'} voted` : 'No votes yet'}</span>${actions}</div></div>`;
}

// ---- the "Create poll" dialog (Messenger style: a question, options you add one by one, a few switches) ----
const POLL_MAX_QUESTION = 200;
const POLL_MAX_OPTION = 100;
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 10;

// The values are what the server's /poll accepts as durations (30 minutes to 30 days).
const POLL_CLOSE_CHOICES = [
  { value: '', label: 'Never' },
  { value: '1h', label: 'In 1 hour' },
  { value: '1d', label: 'In 1 day' },
  { value: '3d', label: 'In 3 days' },
  { value: '7d', label: 'In 1 week' },
];

// When editing, the first choice leaves the current closing time as it is.
const POLL_EDIT_CLOSE_CHOICES = [{ value: 'keep', label: 'Keep as it is' }, { value: 'none', label: 'Never' }, ...POLL_CLOSE_CHOICES.slice(1)];

const pollFilledOptions = (draft) => (draft.options || []).map((option) => String(option).trim()).filter(Boolean);

// A question up to 200 characters and 2 to 10 options of up to 100 (boxes left empty do not count).
function pollDraftValid(draft) {
  const question = String(draft.question || '').trim();
  const options = pollFilledOptions(draft);
  return Boolean(question) && question.length <= POLL_MAX_QUESTION
    && options.length >= POLL_MIN_OPTIONS && options.length <= POLL_MAX_OPTIONS && options.every((option) => option.length <= POLL_MAX_OPTION);
}

// What is sent to POST /api/polls.
function pollDraftRequest(draft, channelId) {
  const request = {
    channelId: Number(channelId), question: String(draft.question || '').trim(), options: pollFilledOptions(draft),
    multiple: Boolean(draft.multiple), anonymous: Boolean(draft.anonymous),
  };
  if (draft.closes) request.closes = draft.closes;
  return request;
}

// A draft to edit an existing poll (the serialized poll from GET /api/polls/:id). Each option keeps its id and its vote count.
function pollDraftFromPoll(poll) {
  return {
    pollId: Number(poll.id), question: poll.question, options: poll.options.map((option) => option.label), optionIds: poll.options.map((option) => Number(option.id)),
    optionVotes: poll.options.map((option) => Number(option.count) || 0), multiple: Boolean(poll.multiple), anonymous: Boolean(poll.anonymous),
    locked: (Number(poll.totalVoters) || 0) > 0, closes: 'keep',
  };
}

// What is sent to PUT /api/polls/:id. Old options keep their id; new ones have none; closes is left out to keep the time as it is.
function pollEditRequest(draft) {
  const options = [];
  (draft.options || []).forEach((label, index) => {
    const text = String(label).trim();
    if (!text) return;
    const id = draft.optionIds ? draft.optionIds[index] : null;
    options.push(id ? { id, label: text } : { label: text });
  });
  const request = { question: String(draft.question || '').trim(), options, multiple: Boolean(draft.multiple), anonymous: Boolean(draft.anonymous) };
  if (draft.closes === 'none') request.closes = '';
  else if (draft.closes && draft.closes !== 'keep') request.closes = draft.closes;
  return request;
}

function pollDialogHtml(draft) {
  const editing = Boolean(draft.pollId);
  const options = draft.options && draft.options.length ? draft.options : ['', ''];
  const hasVotes = (index) => editing && draft.optionVotes && Number(draft.optionVotes[index]) > 0;
  const rows = options.map((option, index) => `<div class="poll-option-row"><input type="text" class="poll-field" data-poll-option="${index}" maxlength="${POLL_MAX_OPTION}" placeholder="Option ${index + 1}" aria-label="Option ${index + 1}" value="${pollEscape(option)}">${options.length > POLL_MIN_OPTIONS && !hasVotes(index) ? `<button type="button" class="poll-remove" data-poll-remove-option="${index}" title="Remove option" aria-label="Remove option ${index + 1}">&times;</button>` : ''}</div>`).join('');
  const choices = editing ? POLL_EDIT_CLOSE_CHOICES : POLL_CLOSE_CHOICES;
  const current = draft.closes || (editing ? 'keep' : '');
  const closes = choices.map((choice) => `<option value="${choice.value}"${choice.value === current ? ' selected' : ''}>${choice.label}</option>`).join('');
  const lock = editing && draft.locked ? ' disabled' : '';
  const lockNote = editing && draft.locked ? '<div class="poll-lock-note">Voting has started, so these two can no longer change.</div>' : '';
  const heading = editing ? 'Edit poll' : 'Create poll';
  return `<div class="modal open poll-modal" role="dialog" aria-modal="true" aria-label="${heading}"><div class="modal-header"><h3>${heading}</h3><button class="modal-close" type="button" data-poll-cancel aria-label="Close">&times;</button></div><div class="modal-body"><label class="poll-field-label" for="poll-question">Question</label><input id="poll-question" type="text" class="poll-field" data-poll-question maxlength="${POLL_MAX_QUESTION}" placeholder="Ask a question..." value="${pollEscape(draft.question || '')}"><div class="poll-field-label">Options</div>${rows}${options.length < POLL_MAX_OPTIONS ? '<button type="button" class="poll-add-option" data-poll-add-option>+ Add option</button>' : ''}<div class="poll-settings"><label class="poll-switch"><input type="checkbox" data-poll-multiple${draft.multiple ? ' checked' : ''}${lock}><span>Allow multiple answers</span></label><label class="poll-switch"><input type="checkbox" data-poll-anonymous${draft.anonymous ? ' checked' : ''}${lock}><span>Anonymous votes</span></label>${lockNote}<label class="poll-end"><span>Poll ends</span><select data-poll-closes>${closes}</select></label></div></div><div class="modal-footer"><button type="button" class="btn" data-poll-cancel>Cancel</button><button type="button" class="btn primary" data-poll-create${pollDraftValid(draft) ? '' : ' disabled'}>${editing ? 'Save changes' : 'Create poll'}</button></div></div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pollCardHtml, pollDialogHtml, pollDraftValid, pollDraftRequest, pollDraftFromPoll, pollEditRequest, POLL_CLOSE_CHOICES };
}
