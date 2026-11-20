// IT Avenue Workspace - the members panel: a collapsible list on the right of a channel or forum with the people who are in it, grouped Online and
// Offline (each group folds away), their status line, and a search. Click a person for their profile card. The toggle is the Members button in
// the channel header. Markup, merging and grouping are pure and tested (frontend/test/people-panel.test.js); the DOM part is at the end.
// Loaded before renderer.js.

const ppEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The channel's member list (GET /api/channels/:id/members) with the live status and status line from the loaded people. You show as online.
function peoplePanelMerge({ members, users, me }) {
  const known = new Map((users || []).map((user) => [Number(user.id), user]));
  return (members || []).map((member) => {
    const person = known.get(Number(member.id));
    const own = me && Number(me.id) === Number(member.id) ? me : null;
    const live = own || person || {};
    return {
      ...member,
      status: own ? 'online' : (person && person.status) || member.status,
      statusText: live.statusText || '',
      statusEmoji: live.statusEmoji || '',
      photoVersion: live.photoVersion || null,
    };
  });
}

// -> { online, offline }: the members (online or away are "Online"), alphabetical, filtered by the words typed
function peoplePanelGroups({ members, query, nameOf }) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const people = (members || [])
    .map((user) => ({ user, name: nameOf(user) }))
    .filter(({ user, name }) => { const text = `${name} ${user.username || ''}`.toLowerCase(); return words.every((word) => text.includes(word)); })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ user }) => user);
  const isOnline = (user) => user.status === 'online' || user.status === 'away';
  return { online: people.filter(isOnline), offline: people.filter((user) => !isOnline(user)) };
}

function ppRow(user, nameOf, offline) {
  const status = user.status === 'online' || user.status === 'away' ? user.status : 'offline';
  const name = nameOf(user);
  const line = user.statusText || user.statusEmoji
    ? `<span class="pp-row-status">${user.statusEmoji ? `${ppEscape(user.statusEmoji)} ` : ''}${ppEscape(user.statusText)}</span>` : '';
  return `<button type="button" class="pp-row${offline ? ' offline' : ''}" data-pp-user="${Number(user.id)}">`
    + `<span class="pp-avatar" style="background:${/^#[0-9a-f]{6}$/i.test(user.avatarColor || '') ? user.avatarColor : '#A855F7'}" data-avatar-user="${Number(user.id)}">${ppEscape(String(name).charAt(0).toUpperCase())}<span class="pp-dot ${status}"></span></span>`
    + `<span class="pp-row-text"><span class="pp-row-name">${ppEscape(name)}</span>${line}</span></button>`;
}

function ppGroup(key, label, people, collapsed, nameOf) {
  const open = !collapsed[key];
  return `<section class="pp-group"><button type="button" class="pp-group-head" data-pp-group="${key}" aria-expanded="${open ? 'true' : 'false'}"><span class="pp-caret" aria-hidden="true">${open ? '&#9662;' : '&#9656;'}</span><span>${label}</span><span class="pp-count">${people.length}</span></button>`
    + `${open ? people.map((user) => ppRow(user, nameOf, key === 'offline')).join('') : ''}</section>`;
}

// collapsed: { online?, offline? } (true = folded); title: for example "Members of #general"
function peoplePanelHtml({ groups, collapsed, query, nameOf, title }) {
  const total = groups.online.length + groups.offline.length;
  const head = `<div class="pp-head"><strong>${ppEscape(title)}</strong><button type="button" class="icon-btn pp-close" data-pp-close title="Hide the member list" aria-label="Hide the member list">&times;</button></div>`
    + `<div class="pp-search"><input type="search" data-pp-search placeholder="Search members" aria-label="Search members" value="${ppEscape(query)}" autocomplete="off" maxlength="60"></div>`;
  if (!total) {
    return `${head}<p class="pp-empty">${String(query || '').trim() ? 'No one matches that search.' : 'No members to show.'}</p>`;
  }
  return `${head}<div class="pp-list">${ppGroup('online', 'Online', groups.online, collapsed || {}, nameOf)}${ppGroup('offline', 'Offline', groups.offline, collapsed || {}, nameOf)}</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { peoplePanelMerge, peoplePanelGroups, peoplePanelHtml };
}

// ---- the panel on screen -------------------------------------------------------------------------------------------------------

const ppState = { open: false, collapsed: { online: false, offline: false }, query: '', channelId: null, loadingFor: null, members: [], fetchedAt: 0, request: 0 };
const PP_FRESH_MS = 30 * 1000;

function ppLoadPrefs() {
  try {
    ppState.open = localStorage.getItem('peoplePanelOpen') === '1';
    const saved = JSON.parse(localStorage.getItem('peoplePanelFolded') || '{}');
    ppState.collapsed = { online: Boolean(saved.online), offline: Boolean(saved.offline) };
  } catch (err) { /* private window: the defaults */ }
}

function ppSavePrefs() {
  try {
    localStorage.setItem('peoplePanelOpen', ppState.open ? '1' : '0');
    localStorage.setItem('peoplePanelFolded', JSON.stringify(ppState.collapsed));
  } catch (err) { /* private window: not remembered */ }
}

// The panel belongs to a channel or forum, so it shows only while one is open.
const ppInChannel = () => Boolean(state.currentChannelId) && state.view === 'channel' && state.section === 'home';

async function ppLoadMembers(force) {
  const channelId = state.currentChannelId;
  if (!channelId) return;
  if (!force && ppState.channelId === channelId && Date.now() - ppState.fetchedAt < PP_FRESH_MS) return;
  const request = ++ppState.request;
  ppState.loadingFor = channelId; // one request at a time per channel; the result renders when it arrives
  try {
    const response = await api(`/api/channels/${channelId}/members`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load the members');
    if (request !== ppState.request || channelId !== state.currentChannelId) return; // another channel was opened meanwhile
    ppState.channelId = channelId; ppState.members = data.members || []; ppState.fetchedAt = Date.now();
  } catch (err) {
    if (request === ppState.request) { ppState.channelId = channelId; ppState.members = []; ppState.fetchedAt = Date.now(); }
    console.error('Load members error:', err);
  } finally {
    if (request === ppState.request) ppState.loadingFor = null;
  }
  renderPeoplePanel();
}

function renderPeoplePanel() {
  const panel = document.getElementById('people-panel');
  const toggle = document.getElementById('btn-channel-members');
  const visible = ppState.open && ppInChannel();
  if (toggle) { toggle.classList.toggle('active', ppState.open); toggle.setAttribute('aria-pressed', ppState.open ? 'true' : 'false'); }
  if (!panel) return;
  panel.hidden = !visible;
  if (!visible) return;
  if (ppState.channelId !== state.currentChannelId) {
    if (ppState.loadingFor !== state.currentChannelId) { ppState.members = []; ppState.query = ''; ppLoadMembers(true); }
  } else if (ppState.loadingFor === null && Date.now() - ppState.fetchedAt > PP_FRESH_MS) ppLoadMembers(false);
  const hadFocus = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-pp-search]');
  const caret = hadFocus ? document.activeElement.selectionStart : null;
  const nameOf = (user) => displayName(user);
  const channel = (state.channels || []).find((item) => Number(item.id) === Number(state.currentChannelId));
  const title = channel ? `Members of ${channel.name}` : 'Members';
  const members = ppState.channelId === state.currentChannelId ? peoplePanelMerge({ members: ppState.members, users: state.users, me: state.user }) : [];
  panel.innerHTML = peoplePanelHtml({ groups: peoplePanelGroups({ members, query: ppState.query, nameOf }), collapsed: ppState.collapsed, query: ppState.query, nameOf, title });
  if (typeof repaintAllAvatars === 'function') repaintAllAvatars();
  if (hadFocus) { const box = panel.querySelector('[data-pp-search]'); box.focus(); box.setSelectionRange(caret, caret); }
}

function setupPeoplePanel() {
  ppLoadPrefs();
  document.getElementById('btn-channel-members')?.addEventListener('click', () => { ppState.open = !ppState.open; ppSavePrefs(); renderPeoplePanel(); });
  const panel = document.getElementById('people-panel');
  if (panel) {
    panel.addEventListener('click', (event) => {
      if (event.target.closest('[data-pp-close]')) { ppState.open = false; ppSavePrefs(); renderPeoplePanel(); return; }
      const group = event.target.closest('[data-pp-group]');
      if (group) { const key = group.dataset.ppGroup; ppState.collapsed[key] = !ppState.collapsed[key]; ppSavePrefs(); renderPeoplePanel(); return; }
      const row = event.target.closest('.pp-row[data-pp-user]');
      if (row && typeof openProfileCard === 'function') {
        event.stopPropagation(); // the app-wide avatar handler would open the card a second time
        openProfileCard(Number(row.dataset.ppUser), row);
      }
    });
    panel.addEventListener('input', (event) => { if (event.target.matches('[data-pp-search]')) { ppState.query = event.target.value; renderPeoplePanel(); } });
  }
  renderPeoplePanel();
}
