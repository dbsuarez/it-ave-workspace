// IT Avenue Workspace - the people panel: a collapsible list on the right of the window with your coworkers grouped Online and Offline (each group
// folds away), their status line, and a search. Click a person for their profile card. Employees only: no guests, bots or yourself.
// Markup and grouping are pure and tested (frontend/test/people-panel.test.js); the DOM part is at the end. Loaded before renderer.js.

const ppEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// -> { online, offline }: employees (online or away are "Online"), alphabetical, filtered by the words typed
function peoplePanelGroups({ users, meId, query, nameOf }) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const people = (users || [])
    .filter((user) => user.accountType === 'member' && Number(user.id) !== Number(meId))
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

// collapsed: { online?, offline? } (true = folded)
function peoplePanelHtml({ groups, collapsed, query, nameOf }) {
  const total = groups.online.length + groups.offline.length;
  const head = `<div class="pp-head"><strong>People</strong><button type="button" class="icon-btn pp-close" data-pp-close title="Hide this panel" aria-label="Hide this panel">&times;</button></div>`
    + `<div class="pp-search"><input type="search" data-pp-search placeholder="Search people" aria-label="Search people" value="${ppEscape(query)}" autocomplete="off" maxlength="60"></div>`;
  if (!total) {
    return `${head}<p class="pp-empty">${String(query || '').trim() ? 'No one matches that search.' : 'No coworkers yet.'}</p>`;
  }
  return `${head}<div class="pp-list">${ppGroup('online', 'Online', groups.online, collapsed || {}, nameOf)}${ppGroup('offline', 'Offline', groups.offline, collapsed || {}, nameOf)}</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { peoplePanelGroups, peoplePanelHtml };
}

// ---- the panel on screen -------------------------------------------------------------------------------------------------------

const ppState = { open: false, collapsed: { online: false, offline: false }, query: '' };

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

function renderPeoplePanel() {
  const panel = document.getElementById('people-panel');
  const toggle = document.getElementById('btn-people-panel');
  if (toggle) { toggle.classList.toggle('active', ppState.open); toggle.setAttribute('aria-pressed', ppState.open ? 'true' : 'false'); }
  if (!panel) return;
  panel.hidden = !ppState.open;
  if (!ppState.open) return;
  const hadFocus = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-pp-search]');
  const caret = hadFocus ? document.activeElement.selectionStart : null;
  const nameOf = (user) => displayName(user);
  panel.innerHTML = peoplePanelHtml({ groups: peoplePanelGroups({ users: state.users, meId: state.user.id, query: ppState.query, nameOf }), collapsed: ppState.collapsed, query: ppState.query, nameOf });
  if (typeof repaintAllAvatars === 'function') repaintAllAvatars();
  if (hadFocus) { const box = panel.querySelector('[data-pp-search]'); box.focus(); box.setSelectionRange(caret, caret); }
}

function setupPeoplePanel() {
  ppLoadPrefs();
  document.getElementById('btn-people-panel')?.addEventListener('click', () => { ppState.open = !ppState.open; ppSavePrefs(); renderPeoplePanel(); });
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
