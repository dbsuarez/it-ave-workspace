// IT Avenue Workspace - the Knowledge Base screen: employees read and search answers; HR (the Manage knowledge base permission) writes them.
// Markup comes from kb-view.js, splitting pasted text from kb-import.js, and the article text is shown with the Canvas reading view
// (canvas-render.js). Loaded before renderer.js, which calls showKnowledgeBaseHome() when the rail item is opened and setupKnowledgeBase() once.

const kbState = {
  canManage: false, categories: [], category: null, articles: [], article: null, sections: [],
  details: null, findTimer: null, returnTo: null, screenOptions: [], importText: '', importLevel: 1, importPublish: false, searchTimer: null, searchId: 0,
};

async function kbJson(path, options) {
  const response = await api(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: response.status, data });
  return data;
}

const kbHost = () => document.getElementById('kb-content');
const kbCanSavePdf = () => Boolean(window.electronAPI && window.electronAPI.exportCanvas); // only the desktop app can save files

function kbRender(html) {
  const host = kbHost();
  if (host) host.innerHTML = html;
}

function kbBodyHtml(sections) {
  return typeof renderCanvasSections === 'function' ? renderCanvasSections(sections, {}) : '';
}

async function showKnowledgeBaseHome() {
  try {
    const data = await kbJson('/api/kb');
    kbState.canManage = data.canManage;
    kbState.categories = data.categories;
    kbState.screenOptions = data.screenOptions || [];
    kbState.category = null; kbState.article = null; kbState.details = null;
    kbRender(kbHomeHtml({ categories: data.categories, canManage: data.canManage }));
  } catch (err) {
    kbRender(`<p class="kb-empty">${kbEscape(err.status === 403 ? 'The Knowledge Base is for workspace members.' : (err.message || 'Could not open the Knowledge Base.'))}</p>`);
  }
}

async function openKbCategory(id) {
  try {
    const data = await kbJson(`/api/kb/categories/${id}`);
    kbState.category = data.category; kbState.articles = data.articles; kbState.article = null;
    kbRender(kbCategoryHtml({ category: data.category, articles: data.articles, canManage: kbState.canManage, canExport: kbCanSavePdf() }));
  } catch (err) { showToast(err.message || 'Could not open that category.', 'error'); }
}

async function openKbArticle(id) {
  try {
    const data = await kbJson(`/api/kb/articles/${id}`);
    kbState.article = data.article; kbState.sections = data.sections;
    kbRender(kbArticleHtml({ article: data.article, bodyHtml: kbBodyHtml(data.sections), siblings: data.siblings, canManage: kbState.canManage, canExport: kbCanSavePdf(), outline: kbOutline(data.sections) }));
    kbStartArticleTools();
    if (typeof cvwLoadImages === 'function') cvwLoadImages(kbHost()); // pictures are fetched with the sign-in
    kbHost()?.scrollTo?.(0, 0);
  } catch (err) { showToast(err.message || 'Could not open that article.', 'error'); }
}

// ---- tools on an open article: find in the article, and the floating "On this page" list ----

const kbArticleBody = () => kbHost()?.querySelector('[data-kb-article-body]');

function kbStartArticleTools() {
  const toc = kbHost()?.querySelector('[data-kb-toc]');
  if (toc) {
    let collapsed = window.innerWidth < 1300; // a narrow window starts with the list folded away
    try { const saved = localStorage.getItem('kbTocCollapsed'); if (saved !== null) collapsed = saved === '1'; } catch (err) { /* private window: keep the default */ }
    kbSetTocCollapsed(collapsed);
  }
  kbSpyHeadings();
}

function kbSetTocCollapsed(collapsed) {
  const toc = kbHost()?.querySelector('[data-kb-toc]');
  if (!toc) return;
  toc.classList.toggle('collapsed', collapsed);
  toc.querySelector('[data-kb-toc-toggle]')?.setAttribute('aria-expanded', String(!collapsed));
}

// The heading nearest the top of the screen is marked in the list as you read.
function kbSpyHeadings() {
  const toc = kbHost()?.querySelector('[data-kb-toc]');
  const view = document.getElementById('view-knowledge-base');
  const body = kbArticleBody();
  if (!toc || !view || !body) return;
  const top = view.getBoundingClientRect().top + 90;
  let activeId = null;
  body.querySelectorAll('.cv-block.cv-heading').forEach((block) => { if (block.getBoundingClientRect().top <= top) activeId = block.dataset.sectionId; });
  toc.querySelectorAll('[data-kb-toc-item]').forEach((item) => item.classList.toggle('active', item.dataset.kbTocItem === activeId));
}

function kbUpdateFindCount(total, position) {
  const count = kbHost()?.querySelector('[data-kb-find-count]');
  if (!count) return;
  const input = kbHost().querySelector('[data-kb-find-input]');
  count.textContent = !input || !input.value.trim() ? '' : (total ? `${position} of ${total}` : 'No matches');
}

function kbRunFind(query) {
  const body = kbArticleBody();
  if (!body) return;
  const total = kbFindApply(body, query);
  kbUpdateFindCount(total, total ? 1 : 0);
}

function kbFindMove(direction) {
  const position = kbFindStep(direction);
  kbUpdateFindCount(kbFindState.marks.length, position);
}

function kbClearFind() {
  const input = kbHost()?.querySelector('[data-kb-find-input]');
  if (input) input.value = '';
  if (kbArticleBody()) kbFindClear(kbArticleBody());
  kbUpdateFindCount(0, 0);
}

// ---- search: as you type, after a short pause ----

async function runKbSearch(text) {
  const results = document.querySelector('[data-kb-results]');
  const cards = document.querySelector('[data-kb-cards]');
  if (!results || !cards) return;
  const query = text.trim();
  if (query.length < 2) { results.hidden = true; cards.hidden = false; return; }
  const id = ++kbState.searchId;
  try {
    const data = await kbJson(`/api/kb/search?q=${encodeURIComponent(query)}`);
    if (id !== kbState.searchId) return; // a newer search is on its way
    results.innerHTML = kbSearchResultsHtml({ query, results: data.results });
    results.hidden = false; cards.hidden = true;
  } catch (err) { showToast(err.message || 'Search failed.', 'error'); }
}

// ---- managing ----

async function kbNewCategory() {
  const title = await askText('Name the category', { placeholder: 'For example: Leave', maxLength: 80, required: true });
  if (!title) return;
  try {
    const data = await kbJson('/api/kb/categories', { method: 'POST', body: JSON.stringify({ title }) });
    await openKbCategory(data.category.id);
  } catch (err) { showToast(err.message || 'Could not add the category.', 'error'); }
}

async function kbRenameCategory() {
  const category = kbState.category;
  if (!category) return;
  const title = await askText('Rename the category', { placeholder: category.title, maxLength: 80, required: true });
  if (!title) return;
  try { await kbJson(`/api/kb/categories/${category.id}`, { method: 'PATCH', body: JSON.stringify({ title }) }); await openKbCategory(category.id); }
  catch (err) { showToast(err.message || 'Could not rename it.', 'error'); }
}

async function kbDeleteCategory() {
  const category = kbState.category;
  if (!category) return;
  const count = kbState.articles.length;
  if (!(await confirmAction({ title: 'Delete this category?', message: `"${category.title}"${count ? ` and its ${count} article${count === 1 ? '' : 's'}` : ''} will be deleted for everyone. This cannot be undone.`, confirmLabel: 'Delete category' }))) return;
  try { await kbJson(`/api/kb/categories/${category.id}`, { method: 'DELETE' }); await showKnowledgeBaseHome(); showToast('Category deleted.', 'success'); }
  catch (err) { showToast(err.message || 'Could not delete it.', 'error'); }
}

async function kbMove(articleId, direction) {
  const ids = kbState.articles.map((article) => article.id);
  const at = ids.indexOf(articleId);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= ids.length) return;
  [ids[at], ids[to]] = [ids[to], ids[at]];
  try { await kbJson(`/api/kb/categories/${kbState.category.id}/order`, { method: 'PUT', body: JSON.stringify({ ids }) }); await openKbCategory(kbState.category.id); }
  catch (err) { showToast(err.message || 'Could not move it.', 'error'); }
}

// ---- the article's details (title, category, published, help screens) in a dialog; its text is written in the Canvas editor ----

const kbDetailsModal = () => document.getElementById('kb-details-modal');

async function kbEnsureCategories() {
  if (!kbState.categories.length || !kbState.screenOptions.length) {
    const data = await kbJson('/api/kb');
    kbState.categories = data.categories; kbState.screenOptions = data.screenOptions || [];
  }
}

function kbRenderDetails() {
  kbDetailsModal().innerHTML = kbDetailsHtml({ draft: kbState.details, categories: kbState.categories, screenOptions: kbState.screenOptions, isNew: kbState.details.isNew });
}

async function kbOpenDetails(articleId) {
  try {
    await kbEnsureCategories();
    if (articleId) {
      const data = kbState.article && kbState.article.id === articleId ? { article: kbState.article } : await kbJson(`/api/kb/articles/${articleId}`);
      const article = data.article;
      kbState.details = { id: article.id, title: article.title, published: article.published, categoryId: article.categoryId, screens: article.screens || [], isNew: false };
    } else {
      kbState.details = { title: '', published: false, categoryId: kbState.category ? kbState.category.id : kbState.categories[0].id, screens: [], isNew: true };
    }
    kbRenderDetails();
    openSettingsModal(kbDetailsModal());
    kbDetailsModal().querySelector('[data-kb-title]')?.focus();
  } catch (err) { showToast(err.message || 'Could not open the details.', 'error'); }
}

async function kbSaveDetails() {
  const modal = kbDetailsModal();
  const details = kbState.details;
  if (!details) return;
  const title = modal.querySelector('[data-kb-title]').value.trim();
  if (!title) { showToast('Give the article a title.', 'error'); modal.querySelector('[data-kb-title]').focus(); return; }
  const body = {
    title,
    categoryId: Number(modal.querySelector('[data-kb-category]').value),
    published: modal.querySelector('[data-kb-published]').checked,
    screens: [...modal.querySelectorAll('[data-kb-screen]:checked')].map((box) => box.dataset.kbScreen),
  };
  try {
    if (details.isNew) {
      const data = await kbJson('/api/kb/articles', { method: 'POST', body: JSON.stringify({ ...body, body: '' }) });
      closeSettingsModal();
      kbState.details = null;
      await kbEditText(data.article.id, data.article.canvasId);
    } else {
      await kbJson(`/api/kb/articles/${details.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      closeSettingsModal();
      kbState.details = null;
      await openKbArticle(details.id);
      showToast('Saved.', 'success');
    }
  } catch (err) { showToast(err.message || 'Could not save it.', 'error'); }
}

// Writing the text of an article: the Canvas editor opens on the article's canvas, with a way back.
async function kbEditText(articleId, canvasId) {
  try {
    let id = canvasId;
    if (!id) id = (kbState.article && kbState.article.id === articleId ? kbState.article : (await kbJson(`/api/kb/articles/${articleId}`)).article).canvasId;
    if (!id) throw new Error('This article has no text to edit.');
    kbState.returnTo = { articleId };
    await setSection('canvas2');
    await openCanvas2Standalone(id);
    kbSyncReturnBar('canvas2');
  } catch (err) { kbState.returnTo = null; showToast(err.message || 'Could not open the Canvas editor.', 'error'); }
}

// The "back to the Knowledge Base" button, shown over the Canvas screen while an article's text is being written.
function kbSyncReturnBar(section) {
  const bar = document.getElementById('kb-return');
  if (!bar) return;
  if (section !== 'canvas2' && section !== 'knowledgebase') kbState.returnTo = null;
  bar.hidden = !(section === 'canvas2' && kbState.returnTo);
}

async function kbBackFromEditor() {
  const back = kbState.returnTo;
  kbState.returnTo = null;
  document.getElementById('kb-return').hidden = true;
  await setSection('knowledgebase');
  if (back) await openKbArticle(back.articleId);
}

async function kbDeleteArticle(id) {
  if (!(await confirmAction({ title: 'Delete this article?', message: 'It is deleted for everyone. This cannot be undone.', confirmLabel: 'Delete article' }))) return;
  try {
    const categoryId = kbState.article ? kbState.article.categoryId : null;
    await kbJson(`/api/kb/articles/${id}`, { method: 'DELETE' });
    showToast('Article deleted.', 'success');
    if (categoryId) await openKbCategory(categoryId); else await showKnowledgeBaseHome();
  } catch (err) { showToast(err.message || 'Could not delete it.', 'error'); }
}

// ---- import: paste Markdown, check the split, add the articles ----

const kbImportModal = () => document.getElementById('kb-import-modal');

function kbRenderImport() {
  const modal = kbImportModal();
  const preview = splitMarkdownIntoArticles(kbState.importText, { level: kbState.importLevel, introTitle: 'Introduction' });
  const active = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-kb-import-text]');
  const caret = active ? document.activeElement.selectionStart : null;
  modal.innerHTML = kbImportHtml({ text: kbState.importText, level: kbState.importLevel, publish: kbState.importPublish, preview, categoryTitle: kbState.category.title });
  if (active) { const box = modal.querySelector('[data-kb-import-text]'); box.focus(); box.setSelectionRange(caret, caret); }
}

function kbOpenImport() {
  if (!kbState.category) return;
  kbState.importText = ''; kbState.importLevel = 1; kbState.importPublish = false;
  kbRenderImport();
  openSettingsModal(kbImportModal());
}

async function kbSaveImport() {
  const split = splitMarkdownIntoArticles(kbState.importText, { level: kbState.importLevel, introTitle: 'Introduction' });
  if (!split.articles.length) return;
  try {
    const data = await kbJson(`/api/kb/categories/${kbState.category.id}/import`, { method: 'POST', body: JSON.stringify({ articles: split.articles, publish: kbState.importPublish }) });
    closeSettingsModal();
    await openKbCategory(kbState.category.id);
    showToast(`${data.created} article${data.created === 1 ? '' : 's'} added${kbState.importPublish ? '' : ' as drafts'}.`, 'success');
  } catch (err) { showToast(err.message || 'Could not import.', 'error'); }
}

// ---- Save as PDF (desktop app): one article, or a whole category as one document ----

async function kbExportPdf(title, html) {
  try {
    showToast('Preparing the PDF…', 'info');
    // pictures are fetched with the sign-in and put into the page, because the printing window has no network
    const pictureIds = [...new Set([...html.matchAll(/data-cv-file="(\d+)"/g)].map((m) => m[1]))];
    if (pictureIds.length && typeof canvasExport !== 'undefined') html = canvasExport.inlinePictures(html, await canvasExport.fetchPictures(pictureIds));
    const result = await window.electronAPI.exportCanvas({ format: 'pdf', title, html });
    if (result && result.path) showToast(`Saved to ${result.path}`, 'success');
  } catch (err) { showToast((err && err.message) || 'Could not save the PDF.', 'error'); }
}

async function kbExportArticle() {
  if (!kbState.article) return;
  await kbExportPdf(kbState.article.title, `<h1>${kbEscape(kbState.article.title)}</h1>${kbBodyHtml(kbState.sections)}`);
}

async function kbExportCategory() {
  if (!kbState.category) return;
  try {
    let html = '';
    for (const summary of kbState.articles.filter((article) => article.published)) {
      const data = await kbJson(`/api/kb/articles/${summary.id}`);
      html += `<h1>${kbEscape(data.article.title)}</h1>${kbBodyHtml(data.sections)}`;
    }
    if (!html) { showToast('There are no published articles to save.', 'info'); return; }
    await kbExportPdf(kbState.category.title, html);
  } catch (err) { showToast(err.message || 'Could not prepare the PDF.', 'error'); }
}

// ---- events ----

function setupKnowledgeBase() {
  const host = kbHost();
  if (!host) return;
  setupKbBackup();
  host.addEventListener('click', (event) => {
    const t = event.target;
    const open = t.closest('[data-kb-open-article]');
    if (open) { openKbArticle(Number(open.dataset.kbOpenArticle)); return; }
    const category = t.closest('[data-kb-open-category]');
    if (category) { openKbCategory(Number(category.dataset.kbOpenCategory)); return; }
    if (t.closest('[data-kb-home]')) { showKnowledgeBaseHome(); return; }
    if (t.closest('[data-kb-find-next]')) { kbFindMove(1); return; }
    if (t.closest('[data-kb-find-prev]')) { kbFindMove(-1); return; }
    const tocToggle = t.closest('[data-kb-toc-toggle]');
    if (tocToggle) {
      const collapsed = !tocToggle.closest('[data-kb-toc]').classList.contains('collapsed');
      kbSetTocCollapsed(collapsed);
      try { localStorage.setItem('kbTocCollapsed', collapsed ? '1' : '0'); } catch (err) { /* private window */ }
      return;
    }
    const tocItem = t.closest('[data-kb-toc-item]');
    if (tocItem) { kbArticleBody()?.querySelector(`[data-section-id="${CSS.escape(tocItem.dataset.kbTocItem)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    if (t.closest('[data-kb-new-category]')) { kbNewCategory(); return; }
    if (t.closest('[data-kb-rename-category]')) { kbRenameCategory(); return; }
    if (t.closest('[data-kb-delete-category]')) { kbDeleteCategory(); return; }
    if (t.closest('[data-kb-new-article]')) { kbOpenDetails(null); return; }
    if (t.closest('[data-kb-import]')) { kbOpenImport(); return; }
    if (t.closest('[data-kb-backup]')) { kbOpenBackup(); return; }
    if (t.closest('[data-kb-restore]')) { kbOpenRestore(); return; }
    const move = t.closest('[data-kb-move]');
    if (move) { kbMove(Number(move.dataset.kbArticle), move.dataset.kbMove); return; }
    const edit = t.closest('[data-kb-edit]');
    if (edit) { kbEditText(Number(edit.dataset.kbEdit)); return; }
    const details = t.closest('[data-kb-details]');
    if (details) { kbOpenDetails(Number(details.dataset.kbDetails)); return; }
    const del = t.closest('[data-kb-delete-article]');
    if (del) { kbDeleteArticle(Number(del.dataset.kbDeleteArticle)); return; }
    if (t.closest('[data-kb-export-article]')) { kbExportArticle(); return; }
    if (t.closest('[data-kb-export-category]')) { kbExportCategory(); return; }
  });
  host.addEventListener('input', (event) => {
    if (event.target.matches('[data-kb-find-input]')) {
      clearTimeout(kbState.findTimer);
      const text = event.target.value;
      kbState.findTimer = setTimeout(() => kbRunFind(text), 150);
    } else if (event.target.matches('[data-kb-search]')) {
      clearTimeout(kbState.searchTimer);
      const text = event.target.value;
      kbState.searchTimer = setTimeout(() => runKbSearch(text), 250);
    }
  });
  host.addEventListener('keydown', (event) => {
    if (!event.target.matches('[data-kb-find-input]')) return;
    if (event.key === 'Enter') { event.preventDefault(); clearTimeout(kbState.findTimer); if (!kbFindState.marks.length) kbRunFind(event.target.value); else kbFindMove(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); kbClearFind(); event.target.blur(); }
  });
  // Ctrl+F (or Cmd+F) on an open article goes to the find box
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== 'f') return;
    const input = document.getElementById('view-knowledge-base')?.classList.contains('active') ? kbHost()?.querySelector('[data-kb-find-input]') : null;
    if (!input) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
  document.getElementById('view-knowledge-base')?.addEventListener('scroll', () => { requestAnimationFrame(kbSpyHeadings); }, { passive: true });
  document.getElementById('kb-return')?.addEventListener('click', () => kbBackFromEditor());
  const details = kbDetailsModal();
  if (details) {
    details.addEventListener('click', (event) => {
      if (event.target.closest('[data-kb-details-close]')) { closeSettingsModal(); return; }
      if (event.target.closest('[data-kb-details-save]')) kbSaveDetails();
    });
  }
  const modal = kbImportModal();
  if (modal) {
    modal.addEventListener('click', (event) => {
      if (event.target.closest('[data-kb-import-close]')) { closeSettingsModal(); return; }
      if (event.target.closest('[data-kb-import-save]')) kbSaveImport();
    });
    modal.addEventListener('input', (event) => { if (event.target.matches('[data-kb-import-text]')) { kbState.importText = event.target.value; kbRenderImport(); } });
    modal.addEventListener('change', (event) => {
      if (event.target.matches('[data-kb-import-level]')) { kbState.importLevel = Number(event.target.value); kbRenderImport(); }
      else if (event.target.matches('[data-kb-import-publish]')) kbState.importPublish = event.target.checked;
    });
  }
}
