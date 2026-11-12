// IT Avenue Workspace - "View as" (docs/ROLES_DESIGN.md).
//
// An Owner opens the app as another person to see what their roles show them. The server gives a one-hour READ-ONLY token
// (backend/src/viewAs.js): nothing can be changed, nothing private to the person is shown, and the live connection is not
// used. The Owner's own sign-in is kept aside and restored by Exit (or when the hour runs out).

function viewAsClaims(token) {
  try {
    const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload && payload.viewAs ? payload : null;
  } catch (err) {
    return null;
  }
}

async function startViewAs(userId) {
  const res = await api('/api/roles/view-as', { method: 'POST', body: JSON.stringify({ userId: Number(userId) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showToast(data.error || 'Could not start View as.', 'error'); return; }
  await electronAPI.storeSet('viewAsReturn', { token: state.token, user: state.user });
  await electronAPI.storeSet('authToken', data.token);
  await electronAPI.storeSet('user', data.user);
  location.reload();
}

async function exitViewAs() {
  const back = await electronAPI.storeGet('viewAsReturn');
  if (back && back.token && back.user) {
    await electronAPI.storeSet('authToken', back.token);
    await electronAPI.storeSet('user', back.user);
    await electronAPI.storeDelete('viewAsReturn');
  }
  location.reload();
}

// Called once the app is up in a View as session: the bar across the top, a read-only look, and an automatic exit.
function applyViewAsMode(claims) {
  state.viewAs = { by: claims.viewAs, until: claims.exp * 1000, full: Boolean(claims.viewFull) };
  document.body.classList.add('view-as');
  if (claims.viewFull) document.body.classList.add('view-as-full');
  const bar = document.createElement('div');
  bar.className = 'view-as-bar';
  bar.setAttribute('role', 'status');
  const name = typeof personName === 'function' ? personName(state.user) : state.user.username;
  bar.innerHTML = `<span>Viewing as <strong>${escapeHtml(name)}</strong>. Read-only: nothing is saved as them. ${claims.viewFull ? 'Testing mode: their private messages, notes and saved items are shown too.' : 'Messages, canvases and lists are made-up samples; nobody\'s private content is shown.'}</span>
    <button type="button" class="btn small" data-view-as-exit>Exit View as</button>`;
  document.body.prepend(bar);
  bar.querySelector('[data-view-as-exit]').addEventListener('click', exitViewAs);
  const left = state.viewAs.until - Date.now();
  setTimeout(exitViewAs, Math.max(1000, left));
}

if (typeof module !== 'undefined' && module.exports) module.exports = { viewAsClaims };
