// IT Avenue Workspace - the Pre-launch / Live card in Moderation (backend/src/launch.js).
//
// One switch for the whole workspace: Pre-launch keeps testing relaxed, Live turns the rules on together (the shared test
// password off, everyone chooses their own, clocking only from the office networks). The card shows what is not ready.

async function loadLaunchCard() {
  const host = document.getElementById('moderation-launch');
  if (!host) return;
  try {
    const res = await api('/api/admin/launch');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the launch status');
    renderLaunchCard(data);
  } catch (err) {
    host.innerHTML = `<div class="moderation-card"><h2>Launch mode</h2><p class="role-error">${escapeHtml(err.message || 'Could not load')}</p></div>`;
  }
}

function renderLaunchCard(state) {
  const host = document.getElementById('moderation-launch');
  if (!host) return;
  const rows = state.checks.map((c) => `
    <div class="launch-check ${c.ok ? 'ok' : (c.blocker ? 'blocker' : 'warn')}">
      <span class="launch-mark" aria-hidden="true">${c.ok ? '&#10003;' : (c.blocker ? '&#10007;' : '!')}</span>
      <div><strong>${escapeHtml(c.label)}</strong><small>${escapeHtml(c.detail)}</small></div>
    </div>`).join('');
  host.innerHTML = `
    <div class="moderation-card launch-card ${state.live ? 'is-live' : ''}">
      <div class="roles-head">
        <div><h2>Launch mode: <span class="launch-state">${state.live ? 'Live' : 'Pre-launch'}</span></h2>
          <p class="moderation-help">${state.live
    ? 'The workspace is live: everyone uses their own password and clocking is limited to the office networks.'
    : 'Testing mode: a shared test password may be on and clocking works from anywhere. Going live turns the rules on together.'}</p></div>
        ${state.live
    ? '<button type="button" class="btn" data-launch-back>Return to pre-launch…</button>'
    : `<button type="button" class="btn primary" data-launch-go${state.blockers.length ? ' disabled' : ''}>Go live…</button>`}
      </div>
      <div class="launch-checks">${rows}</div>
    </div>`;
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const go = event.target.closest ? event.target.closest('[data-launch-go]') : null;
    const back = event.target.closest ? event.target.closest('[data-launch-back]') : null;
    if (!go && !back) return;
    if (go) {
      const ok = await confirmAction({
        title: 'Go live?',
        message: 'Every employee will have to choose a new password at their next sign-in, the shared test password is switched off, and clocking will only work from the office networks. Superadmins keep their passwords.',
        confirmLabel: 'Go live',
      });
      if (!ok) return;
    } else {
      const ok = await confirmAction({
        title: 'Return to pre-launch?',
        message: 'Clocking from anywhere is allowed again. Passwords are not changed, and the shared test password stays off.',
        confirmLabel: 'Return to pre-launch',
        danger: false,
      });
      if (!ok) return;
    }
    const res = await api(go ? '/api/admin/launch/go-live' : '/api/admin/launch/pre-launch', { method: 'POST', body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || 'Could not change the launch mode.', 'error'); return; }
    showToast(go ? `The workspace is live. ${data.mustChange || 0} people will choose a new password.` : 'Back to pre-launch.', 'success');
    renderLaunchCard(data);
  });
}
