// IT Avenue Workspace - Canvas comments: threads in a panel, a comment button on every block in the reading view.
//
// Loaded after canvas-view.js and before renderer.js. A comment can quote the passage it is about
// (the text of the block you pressed the bubble on); replies are flat under the top-level comment, and a
// whole thread can be resolved. Anyone who can read the canvas sees the threads; editors write.

const ccState = { which: null, anchor: '', comments: [], filter: 'open', loading: false };

function ccView() {
  return ccState.which ? canvasViews[ccState.which] : null;
}

function ccCanvasId() {
  const view = ccView();
  return view ? view.id() : null;
}

// Pure: flat list from the server -> threads [{ root, replies[] }], oldest first.
function ccThreads(comments) {
  const roots = comments.filter((c) => !c.parentId);
  return roots.map((root) => ({ root, replies: comments.filter((c) => c.parentId === root.id) }));
}

function ccTime(value) {
  try { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; }
}

function ccBodyHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function ccCommentHtml(comment, canEdit) {
  const mine = comment.author && state.user && Number(comment.author.id) === Number(state.user.id);
  const who = comment.author ? comment.author.username : 'Deleted user';
  return `<div class="cc-comment">
    <div class="cc-meta"><strong>${escapeHtml(who)}</strong><span>${escapeHtml(ccTime(comment.createdAt))}</span>
      ${mine && canEdit ? `<button type="button" class="cc-link" data-cc-delete="${comment.id}">Delete</button>` : ''}
    </div>
    <div class="cc-body">${ccBodyHtml(comment.body)}</div>
  </div>`;
}

function ccRender() {
  const view = ccView();
  const list = document.getElementById('canvas-comments-list');
  if (!view || !list) return;
  const canEdit = view.canEdit;
  const all = ccThreads(ccState.comments);
  const shown = all.filter((t) => (ccState.filter === 'all' ? true : ccState.filter === 'resolved' ? t.root.resolved : !t.root.resolved));
  document.getElementById('canvas-comments-filter').value = ccState.filter;
  const composer = document.getElementById('canvas-comments-composer');
  composer.hidden = !canEdit;
  const anchor = document.getElementById('canvas-comments-anchor');
  anchor.hidden = !ccState.anchor;
  anchor.querySelector('span').textContent = ccState.anchor;
  if (ccState.loading) { list.innerHTML = '<p class="cc-empty">Loading…</p>'; return; }
  if (!shown.length) {
    const none = ccState.filter === 'resolved' ? 'No resolved threads.' : ccState.filter === 'all' ? 'No comments yet.' : 'No open comments.';
    list.innerHTML = `<p class="cc-empty">${none}${canEdit && ccState.filter !== 'resolved' ? ' Write the first one above.' : ''}</p>`;
    return;
  }
  list.innerHTML = shown.map(({ root, replies }) => `
    <article class="cc-thread${root.resolved ? ' resolved' : ''}" data-cc-thread="${root.id}">
      ${root.anchor ? `<blockquote class="cc-anchor">${escapeHtml(root.anchor)}</blockquote>` : ''}
      ${ccCommentHtml(root, canEdit)}
      ${replies.map((r) => ccCommentHtml(r, canEdit)).join('')}
      ${root.resolved ? `<div class="cc-resolved">Resolved${root.resolvedBy ? ` by ${escapeHtml(root.resolvedBy.username)}` : ''}</div>` : ''}
      ${canEdit ? `<form class="cc-reply" data-cc-reply="${root.id}">
          <input type="text" maxlength="2000" placeholder="Reply…" aria-label="Reply">
          <button class="btn" type="submit">Reply</button>
          <button class="btn" type="button" data-cc-resolve="${root.id}" data-resolved="${root.resolved ? '1' : '0'}">${root.resolved ? 'Reopen' : 'Resolve'}</button>
        </form>` : ''}
    </article>`).join('');
}

function ccUpdateCount(which) {
  const button = document.getElementById(which === 'standalone' ? 'btn-canvas2-comments' : 'btn-canvas-sheet-comments');
  if (!button) return;
  const open = ccState.counts?.[which] || 0;
  button.textContent = open > 0 ? `Comments (${open})` : 'Comments';
}

ccState.counts = {};

async function ccFetch(canvasId) {
  const res = await api(`/api/canvas/${canvasId}/comments`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not load comments');
  return data.comments;
}

// Called by canvas-view.js when a canvas is opened, and when comments change elsewhere.
async function ccRefreshCount(which) {
  const id = canvasViews[which].id();
  if (!id) return;
  try {
    const comments = await ccFetch(id);
    if (Number(canvasViews[which].id()) !== Number(id)) return;
    ccState.counts[which] = ccThreads(comments).filter((t) => !t.root.resolved).length;
    ccUpdateCount(which);
    if (ccState.which === which && document.getElementById('canvas-comments-modal')?.classList.contains('open')) {
      ccState.comments = comments;
      ccRender();
    }
  } catch (err) {
    // the button just keeps its label; opening the panel shows the real error
  }
}

async function ccOpen(which, anchor = '') {
  const view = canvasViews[which];
  const modal = document.getElementById('canvas-comments-modal');
  if (!view || !view.id() || !modal) return;
  ccState.which = which;
  ccState.anchor = anchor;
  ccState.loading = true;
  ccState.filter = 'open';
  ccRender();
  openSettingsModal(modal);
  try {
    ccState.comments = await ccFetch(view.id());
    ccState.loading = false;
    ccState.counts[which] = ccThreads(ccState.comments).filter((t) => !t.root.resolved).length;
    ccUpdateCount(which);
    ccRender();
    if (view.canEdit) document.getElementById('canvas-comments-input').focus();
  } catch (err) {
    ccState.loading = false;
    document.getElementById('canvas-comments-list').innerHTML = `<p class="cc-empty">${escapeHtml(err.message || 'Could not load comments.')}</p>`;
  }
}

async function ccPost(body, parentId) {
  const canvasId = ccCanvasId();
  const payload = { body };
  if (parentId) payload.parentId = parentId;
  else if (ccState.anchor) payload.anchor = ccState.anchor;
  const res = await api(`/api/canvas/${canvasId}/comments`, { method: 'POST', body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not post the comment');
  ccState.comments = await ccFetch(canvasId);
  ccState.counts[ccState.which] = ccThreads(ccState.comments).filter((t) => !t.root.resolved).length;
  ccUpdateCount(ccState.which);
  ccRender();
}

// The reading view gets a comment bubble on each block (shown on hover); it quotes that block.
function ccDecorate(which, container) {
  if (!canvasViews[which].canEdit) return; // viewers read threads from the header button
  container.querySelectorAll('.cv-block').forEach((block) => {
    if (block.querySelector('.cv-comment-btn')) return;
    const text = (block.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cv-comment-btn';
    button.title = 'Comment on this';
    button.setAttribute('aria-label', 'Comment on this');
    button.dataset.ccAnchor = text;
    button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    block.appendChild(button);
  });
}

// Called when someone else adds, resolves or deletes a comment on a canvas that is open here.
function canvasCommentsChanged(canvasId) {
  for (const which of Object.keys(canvasViews)) {
    if (Number(canvasViews[which].id()) === Number(canvasId)) ccRefreshCount(which);
  }
}

if (typeof document !== 'undefined') document.addEventListener('click', async (event) => {
  const openButton = event.target.closest('#btn-canvas2-comments, #btn-canvas-sheet-comments');
  if (openButton) {
    ccOpen(openButton.id === 'btn-canvas2-comments' ? 'standalone' : 'sheet');
    return;
  }
  const bubble = event.target.closest('.cv-comment-btn');
  if (bubble) {
    const which = bubble.closest('#canvas2-render') ? 'standalone' : 'sheet';
    ccOpen(which, bubble.dataset.ccAnchor || '');
    return;
  }
  if (event.target.closest('#btn-canvas-comments-clear-anchor')) {
    ccState.anchor = '';
    ccRender();
    return;
  }
  const resolve = event.target.closest('[data-cc-resolve]');
  if (resolve) {
    try {
      const res = await api(`/api/canvas/${ccCanvasId()}/comments/${resolve.dataset.ccResolve}`, {
        method: 'PATCH', body: JSON.stringify({ resolved: resolve.dataset.resolved !== '1' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update the thread');
      ccState.comments = await ccFetch(ccCanvasId());
      ccState.counts[ccState.which] = ccThreads(ccState.comments).filter((t) => !t.root.resolved).length;
      ccUpdateCount(ccState.which);
      ccRender();
    } catch (err) { showToast(err.message || 'Could not update the thread.', 'error'); }
    return;
  }
  const del = event.target.closest('[data-cc-delete]');
  if (del) {
    const ok = await confirmAction({ title: 'Delete this comment?', message: 'If it starts a thread, the replies are deleted too.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const res = await api(`/api/canvas/${ccCanvasId()}/comments/${del.dataset.ccDelete}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete the comment');
      ccState.comments = await ccFetch(ccCanvasId());
      ccState.counts[ccState.which] = ccThreads(ccState.comments).filter((t) => !t.root.resolved).length;
      ccUpdateCount(ccState.which);
      ccRender();
    } catch (err) { showToast(err.message || 'Could not delete the comment.', 'error'); }
  }
});

if (typeof document !== 'undefined') document.addEventListener('submit', async (event) => {
  const composer = event.target.closest('#canvas-comments-composer');
  const reply = event.target.closest('[data-cc-reply]');
  if (!composer && !reply) return;
  event.preventDefault();
  try {
    if (composer) {
      const input = document.getElementById('canvas-comments-input');
      const body = input.value.trim();
      if (!body) return;
      await ccPost(body, null);
      input.value = '';
      ccState.anchor = '';
      ccRender();
    } else {
      const input = reply.querySelector('input');
      const body = input.value.trim();
      if (!body) return;
      await ccPost(body, Number(reply.dataset.ccReply));
    }
  } catch (err) {
    showToast(err.message || 'Could not post the comment.', 'error');
  }
});

if (typeof document !== 'undefined') document.addEventListener('change', (event) => {
  if (event.target.id === 'canvas-comments-filter') {
    ccState.filter = event.target.value;
    ccRender();
  }
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ccThreads };
}
