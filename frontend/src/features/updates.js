// IT Avenue Workspace - app updates in the window: the "version ready" notice, and the "What's new" window shown once after an update
// (and from Help). The pure parts are changelog.js and update-banner.js; the main process does the downloading (main.js).
// Loaded before renderer.js, which calls setupUpdates() once.

const updatesState = { state: { status: 'idle' }, dismissed: null };
const UPDATES_LAST_SEEN = 'lastSeenVersion';

function updatesBannerHost() {
  let host = document.getElementById('update-banner-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'update-banner-host';
    document.body.appendChild(host);
  }
  return host;
}

function renderUpdateBanner() {
  const { state, dismissed } = updatesState;
  updatesBannerHost().innerHTML = state.status === 'ready' && dismissed === state.version ? '' : updateBannerHtml(state);
}

function showWhatsNew(entries, title = "What's new") {
  const modal = document.getElementById('whatsnew-modal');
  if (!modal || !entries.length) return;
  modal.querySelector('[data-whatsnew-title]').textContent = title;
  modal.querySelector('[data-whatsnew-body]').innerHTML = whatsNewHtml(entries);
  openSettingsModal(modal);
}

// After an update: once, what changed since the version this person last saw. The first run only records the version.
async function showWhatsNewAfterUpdate() {
  const api = window.electronAPI;
  if (!api || !api.getAppRelease) return;
  let current;
  try { current = (await api.getAppRelease()).version; } catch { return; }
  let lastSeen = null;
  try { lastSeen = localStorage.getItem(UPDATES_LAST_SEEN); } catch { /* private window: show nothing rather than every time */ return; }
  try { localStorage.setItem(UPDATES_LAST_SEEN, current); } catch { return; }
  if (!lastSeen) return; // a first run: nothing "new" to announce
  showWhatsNew(entriesSince(parseChangelog(CHANGELOG_MARKDOWN), lastSeen, current));
}

function openFullChangelog() {
  showWhatsNew(parseChangelog(CHANGELOG_MARKDOWN), "What's new in every version");
}

function setupUpdates() {
  const api = window.electronAPI;
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-whatsnew-close]')) { closeSettingsModal(); return; }
    if (event.target.closest('[data-help-whatsnew]')) { openFullChangelog(); return; }
    if (event.target.closest('[data-update-later]')) { updatesState.dismissed = updatesState.state.version; renderUpdateBanner(); return; }
    if (event.target.closest('[data-update-install]') && api && api.installUpdate) api.installUpdate();
  });
  showWhatsNewAfterUpdate();
  if (!api || !api.onUpdateStatus) return;
  api.onUpdateStatus((state) => { updatesState.state = state; renderUpdateBanner(); });
  if (api.getUpdateState) api.getUpdateState().then((state) => { updatesState.state = state; renderUpdateBanner(); }).catch(() => {});
}
