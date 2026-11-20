// IT Avenue Workspace - the small update notice in the app. Pure (frontend/test/update-policy.test.js): state in, HTML out.
// A failed check is not shown to people; a download shows its progress; a ready update asks before restarting.

const ubEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function updateBannerHtml(state) {
  if (!state) return '';
  if (state.status === 'downloading') {
    return `<div class="update-banner" role="status"><span>Downloading version ${ubEscape(state.version)}… ${Number(state.percent) || 0}%</span></div>`;
  }
  if (state.status === 'ready') {
    return `<div class="update-banner ready" role="status"><span><strong>Version ${ubEscape(state.version)} is ready.</strong> It installs when you quit the app, or restart now.</span><button type="button" class="btn primary small" data-update-install>Restart now</button><button type="button" class="btn small" data-update-later>Later</button></div>`;
  }
  return '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { updateBannerHtml };
}
