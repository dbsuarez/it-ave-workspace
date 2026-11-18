// IT Avenue Workspace - the interactive card shown for a message with kind 'poll'.
//
// A pure function: poll data in, HTML out, every value escaped. Voting, withdrawing and closing are handled by
// delegated click handlers in renderer.js, which read the data attributes written here. Loaded before renderer.js.

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
      : (Array.isArray(option.voters) && option.voters.length ? `<small class="poll-voters">${option.voters.map(pollEscape).join(', ')}</small>` : '');
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
