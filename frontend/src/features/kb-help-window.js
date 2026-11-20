// IT Avenue Workspace - the Help window: a Knowledge Base article opened from a screen's Help tab floats over the screen you are
// working in, so you read it without being taken to the Knowledge Base. Drag it by its title bar, resize it from the corner, close it
// with x or Esc. "Open in Knowledge Base" is there if you do want the full screen. The markup and the position rule are pure and tested
// (frontend/test/kb-help-window.test.js); the DOM part is at the end. Loaded before kb-screen-help.js.

const kbHwEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// bodyHtml: the article text already turned into safe HTML by the Canvas reading view
function kbHelpWindowHtml({ title, bodyHtml, articleId }) {
  return `<div class="kb-hw-head" data-kb-help-window-drag><strong class="kb-hw-title">${kbHwEscape(title)}</strong>`
    + `<button type="button" class="icon-btn kb-hw-btn" data-kb-help-window-open="${Number(articleId)}" title="Open in the Knowledge Base" aria-label="Open in the Knowledge Base"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg></button>`
    + `<button type="button" class="icon-btn kb-hw-btn" data-kb-help-window-close title="Close" aria-label="Close this window">&times;</button></div>`
    + `<div class="kb-hw-body kb-body cv-body">${bodyHtml}</div>`;
}

// Where the window's top-left corner may be: at least 80px of its width stays on screen on either side, its title bar never goes above
// the screen, and at least 40px of it stays above the bottom edge, so it can always be grabbed again.
function kbHelpWindowClamp({ left, top, width, height, vw, vh }) {
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  return { left: clamp(left, 80 - width, vw - 80), top: clamp(top, 0, vh - 40) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { kbHelpWindowHtml, kbHelpWindowClamp };
}

// ---- the window on screen ----------------------------------------------------------------------------------------------------

const kbHw = { el: null, articleId: null, left: null, top: null, request: 0 };

function kbHelpWindowClose() {
  kbHw.request += 1;
  kbHw.articleId = null;
  if (kbHw.el) { kbHw.el.remove(); kbHw.el = null; }
}

function kbHelpWindowPlace() {
  if (!kbHw.el) return;
  const rect = kbHw.el.getBoundingClientRect();
  const view = { vw: window.innerWidth, vh: window.innerHeight };
  if (kbHw.left === null) {
    kbHw.left = Math.max(12, view.vw - rect.width - 56);
    kbHw.top = 84;
  }
  const spot = kbHelpWindowClamp({ left: kbHw.left, top: kbHw.top, width: rect.width, height: rect.height, ...view });
  kbHw.left = spot.left; kbHw.top = spot.top;
  kbHw.el.style.left = `${spot.left}px`;
  kbHw.el.style.top = `${spot.top}px`;
}

async function kbOpenHelpWindow(articleId) {
  const request = ++kbHw.request;
  try {
    const data = await kbJson(`/api/kb/articles/${articleId}`);
    if (request !== kbHw.request) return; // another article was asked for meanwhile
    if (!kbHw.el) {
      kbHw.el = document.createElement('div');
      kbHw.el.className = 'kb-help-window';
      kbHw.el.setAttribute('role', 'dialog');
      kbHw.el.setAttribute('aria-label', 'Help article');
      document.body.appendChild(kbHw.el);
    }
    kbHw.articleId = articleId;
    kbHw.el.innerHTML = kbHelpWindowHtml({ title: data.article.title, bodyHtml: kbBodyHtml(data.sections), articleId });
    if (typeof cvwLoadImages === 'function') cvwLoadImages(kbHw.el); // pictures are fetched with the sign-in
    kbHw.el.querySelector('.kb-hw-body').scrollTop = 0;
    kbHelpWindowPlace();
  } catch (err) { showToast(err.message || 'Could not open that article.', 'error'); }
}

function setupKbHelpWindow() {
  document.addEventListener('click', (event) => {
    if (!kbHw.el) return;
    if (event.target.closest('[data-kb-help-window-close]')) { kbHelpWindowClose(); return; }
    const open = event.target.closest('[data-kb-help-window-open]');
    if (open) { const id = Number(open.dataset.kbHelpWindowOpen); kbHelpWindowClose(); kbOpenHelpArticle(id); }
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && kbHw.el) kbHelpWindowClose(); });
  window.addEventListener('resize', kbHelpWindowPlace);
  // dragging by the title bar (not by its buttons)
  document.addEventListener('pointerdown', (event) => {
    const handle = kbHw.el && event.target.closest('[data-kb-help-window-drag]');
    if (!handle || event.target.closest('button') || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX; const startY = event.clientY;
    const startLeft = kbHw.left; const startTop = kbHw.top;
    const move = (e) => { kbHw.left = startLeft + e.clientX - startX; kbHw.top = startTop + e.clientY - startY; kbHelpWindowPlace(); };
    const stop = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', stop); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
  });
}
