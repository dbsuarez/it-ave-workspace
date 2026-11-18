// IT Avenue Workspace - the interactive card shown for a message with kind 'poll'.
//
// A pure function: poll data in, HTML out, every value escaped. Voting, withdrawing and closing are handled by
// delegated click handlers in renderer.js, which read the data attributes written here. Loaded before renderer.js.

function pollEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pollCardHtml(poll, { canClose = false } = {}) {
  const mine = new Set((poll.myOptionIds || []).map(Number));
  const total = Number(poll.totalVoters) || 0;
  const options = (poll.options || []).map((option) => {
    const id = Number(option.id);
    const count = Number(option.count) || 0;
    const percent = total ? Math.round((count / total) * 100) : 0;
    const selected = mine.has(id);
    const voters = Array.isArray(option.voters) && option.voters.length
      ? `<small class="poll-voters">${option.voters.map(pollEscape).join(', ')}</small>` : '';
    return `<div class="poll-row"><button type="button" class="poll-option${selected ? ' selected' : ''}" data-poll-vote="${id}" aria-pressed="${selected}"${poll.closed ? ' disabled' : ''}>
        <span class="poll-bar" style="width:${percent}%"></span><span class="poll-label">${pollEscape(option.label)}</span><span class="poll-count">${count} (${percent}%)</span>
      </button>${voters}</div>`;
  }).join('');
  const meta = [
    poll.multiple ? 'Pick any' : 'Pick one',
    poll.anonymous ? 'Anonymous' : 'Votes are visible',
    poll.closed ? 'Closed' : (poll.closesAt ? `Closes ${pollEscape(new Date(poll.closesAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}` : ''),
  ].filter(Boolean).join(' · ');
  const actions = !poll.closed
    ? `${mine.size ? '<button type="button" class="btn poll-action" data-poll-withdraw>Withdraw vote</button>' : ''}${canClose ? '<button type="button" class="btn poll-action" data-poll-close>Close poll</button>' : ''}`
    : '';
  return `<div class="poll-card" data-poll-id="${Number(poll.id)}" data-poll-multiple="${poll.multiple ? 1 : 0}" data-poll-mine="${[...mine].sort((a, b) => a - b).join(',')}" data-poll-can-close="${canClose ? 1 : 0}">
    <div class="poll-question">${pollEscape(poll.question)}</div>
    <div class="poll-meta">${meta}</div>
    <div class="poll-options">${options}</div>
    <div class="poll-footer"><span>${total ? `${total} ${total === 1 ? 'person' : 'people'} voted` : 'No votes yet'}</span>${actions}</div>
  </div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pollCardHtml };
}
