// IT Avenue Workspace - the profile card: click a person's name or picture and a small card opens beside it, with their photo and colour,
// full name, job title, status, how many channels you share, department, location and manager, a box to message them, and a call button.
// It never shows email, phone or role names (the full profile page has the contact details they chose to share).
// The markup and the position rule are pure and tested (frontend/test/profile-card.test.js); the DOM part is at the end.
// Replaces the old centred "Profile" window. Loaded before renderer.js.

const pcEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PC_STATUSES = new Set(['online', 'away', 'offline']);

// card: the API's card; name: the person's full name (username only as the fallback), already worked out by the caller
function profileCardHtml({ card, name, isSelf }) {
  const color = /^#[0-9a-f]{6}$/i.test(card.avatarColor || '') ? card.avatarColor : '#6b21a8';
  const status = PC_STATUSES.has(card.status) ? card.status : 'offline';
  const initial = pcEscape(String(name || card.username || '?').trim().charAt(0).toUpperCase() || '?');
  const chips = [card.department, card.location].filter(Boolean).map((text) => `<span class="pcard2-chip">${pcEscape(text)}</span>`);
  if (card.managerName) chips.push(`<span class="pcard2-chip">Reports to ${pcEscape(card.managerName)}</span>`);
  const statusLine = card.statusText || card.statusEmoji
    ? `<p class="pcard2-status-text">${card.statusEmoji ? `${pcEscape(card.statusEmoji)} ` : ''}${pcEscape(card.statusText)}</p>` : '';
  const shared = !isSelf && Number.isInteger(card.sharedChannels)
    ? `<p class="pcard2-shared">${card.sharedChannels} shared channel${card.sharedChannels === 1 ? '' : 's'}</p>` : '';
  const buttons = isSelf ? '' : `<button type="button" class="pcard2-icon" data-pcard-huddle="${Number(card.id)}" title="Start a call" aria-label="Start a call"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg></button>`;
  const more = `<span class="pcard2-more-wrap"><button type="button" class="pcard2-icon" data-pcard-more title="More" aria-label="More" aria-haspopup="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button><div class="pcard2-menu" data-pcard-menu hidden><button type="button" data-pcard-page="${Number(card.id)}">View full profile</button></div></span>`;
  const footer = isSelf
    ? '<button type="button" class="btn pcard2-edit" data-pcard-edit>Edit profile</button>'
    : `<input type="text" class="pcard2-message" data-pcard-message="${Number(card.id)}" placeholder="Message ${pcEscape(name)}" aria-label="Message ${pcEscape(name)}" maxlength="2000" autocomplete="off">`;
  return `<div class="pcard2-banner" style="background: linear-gradient(135deg, ${color}, ${color}99)"></div>`
    + `<div class="pcard2-tools">${buttons}${more}</div>`
    + `<div class="pcard2-avatar" data-pcard-avatar="${Number(card.id)}" style="background:${color}">${initial}<span class="pcard2-dot ${status}"></span></div>`
    + `<div class="pcard2-body"><h3 class="pcard2-name">${pcEscape(name)}</h3>`
    + `<p class="pcard2-sub"><span class="pcard2-username">@${pcEscape(card.username)}</span>${card.jobTitle ? `<span class="pcard2-title">${pcEscape(card.jobTitle)}</span>` : ''}</p>`
    + `${statusLine}${shared}${chips.length ? `<div class="pcard2-chips">${chips.join('')}</div>` : ''}</div>`
    + `<div class="pcard2-foot">${footer}</div>`;
}

// Where the card's top-left corner goes: beside the clicked name or picture (on the right if there is room, otherwise on the left),
// level with its top, and kept fully on the screen. anchor: { left, top, right, bottom }.
function profileCardPosition({ anchor, width, height, vw, vh, margin = 12 }) {
  let left = anchor.right + 10;
  if (left + width > vw - margin) left = anchor.left - width - 10;
  left = Math.min(Math.max(left, 0), Math.max(0, vw - width - margin));
  const top = Math.min(Math.max(anchor.top, margin), Math.max(margin, vh - height - margin));
  return { left, top };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { profileCardHtml, profileCardPosition };
}

// ---- the card on screen ------------------------------------------------------------------------------------------------------

const pcState = { el: null, userId: null, request: 0 };

function closeProfileCard() {
  pcState.request += 1;
  pcState.userId = null;
  if (pcState.el) { pcState.el.remove(); pcState.el = null; }
}

async function openProfileCard(userId, anchor) {
  const request = ++pcState.request;
  const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 200, top: 120, right: 240, bottom: 160 };
  try {
    const response = await api(`/api/users/${userId}/card`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not load this profile.');
    if (request !== pcState.request) return; // another person was asked for meanwhile
    const card = data.card;
    const isSelf = Number(card.id) === Number(state.user.id);
    if (pcState.el) pcState.el.remove();
    const el = document.createElement('div');
    el.className = 'pcard2';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Profile');
    el.innerHTML = profileCardHtml({ card, name: displayName(card, 'Workspace member'), isSelf });
    document.body.appendChild(el);
    pcState.el = el; pcState.userId = Number(card.id);
    const avatar = el.querySelector('.pcard2-avatar');
    // their photo comes from the card itself (the person may not be in the loaded list); with none, the initial on their colour stays
    if (avatar && card.photoVersion && typeof paintAvatar === 'function') paintAvatar(avatar, { id: card.id, photoVersion: card.photoVersion });
    const spot = profileCardPosition({ anchor: rect, width: el.offsetWidth, height: el.offsetHeight, vw: window.innerWidth, vh: window.innerHeight });
    el.style.left = `${spot.left}px`;
    el.style.top = `${spot.top}px`;
    el.querySelector('[data-pcard-message]')?.focus();
  } catch (err) {
    showToast(err.message || 'Could not load this profile.', 'error');
  }
}

async function sendFromProfileCard(userId, text) {
  const body = String(text || '').trim();
  closeProfileCard();
  await openDM(userId);
  if (!body) return;
  els.dmMessageInput.value = body;
  sendDmMessage();
}

function setupProfileCard() {
  document.addEventListener('click', (event) => {
    if (!pcState.el) return;
    const t = event.target;
    if (!pcState.el.contains(t)) { closeProfileCard(); return; }
    if (t.closest('[data-pcard-more]')) { const menu = pcState.el.querySelector('[data-pcard-menu]'); menu.hidden = !menu.hidden; return; }
    const page = t.closest('[data-pcard-page]');
    if (page) { const id = Number(page.dataset.pcardPage); closeProfileCard(); openPersonPage(id); return; }
    const huddle = t.closest('[data-pcard-huddle]');
    if (huddle) { const id = Number(huddle.dataset.pcardHuddle); closeProfileCard(); startDirectHuddle(id); return; }
    if (t.closest('[data-pcard-edit]')) { closeProfileCard(); openProfileModal(); }
  });
  document.addEventListener('keydown', (event) => {
    if (!pcState.el) return;
    if (event.key === 'Escape') { closeProfileCard(); return; }
    if (event.key === 'Enter' && event.target.matches && event.target.matches('[data-pcard-message]')) {
      event.preventDefault();
      sendFromProfileCard(Number(event.target.dataset.pcardMessage), event.target.value);
    }
  });
  window.addEventListener('resize', closeProfileCard);
}
