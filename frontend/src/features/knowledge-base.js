// IT Avenue Workspace - the Knowledge Base screen: employees read and search answers; HR (the Manage knowledge base permission) writes them.
// Markup comes from kb-view.js, splitting pasted text from kb-import.js, and the article text is shown with the Canvas reading view
// (canvas-render.js). Loaded before renderer.js, which calls showKnowledgeBaseHome() when the rail item is opened and setupKnowledgeBase() once.

const kbState = {
  canManage: false, categories: [], category: null, articles: [], article: null, sections: [],
  draft: null, importText: '', importLevel: 1, importPublish: false, searchTimer: null, searchId: 0,
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
    kbState.category = null; kbState.article = null; kbState.draft = null;
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
    kbRender(kbArticleHtml({ article: data.article, bodyHtml: kbBodyHtml(data.sections), siblings: data.siblings, canManage: kbState.canManage, canExport: kbCanSavePdf() }));
    kbHost()?.scrollTo?.(0, 0);
  } catch (err) { showToast(err.message || 'Could not open that article.', 'error'); }
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

function kbOpenEditor(draft, isNew) {
  kbState.draft = { ...draft, isNew };
  kbRender(kbEditorHtml({ draft, categories: kbState.categories, isNew }));
  kbUpdatePreview(0);
  kbHost()?.querySelector('[data-kb-title]')?.focus();
}

// The preview next to the text: the same reading view employees will see, built in the browser from the Markdown as typed.
let kbPreviewTimer = null;
let kbPreviewId = 0;
function kbUpdatePreview(delay = 300) {
  clearTimeout(kbPreviewTimer);
  kbPreviewTimer = setTimeout(async () => {
    const preview = kbHost()?.querySelector('[data-kb-preview]');
    const body = kbHost()?.querySelector('[data-kb-body]');
    if (!preview || !body) return;
    const id = ++kbPreviewId;
    try {
      const data = await kbJson('/api/kb/preview', { method: 'POST', body: JSON.stringify({ body: body.value }) });
      if (id === kbPreviewId && kbHost()?.contains(preview)) preview.innerHTML = kbBodyHtml(data.sections);
    } catch (err) { preview.innerHTML = `<p class="kb-hint">${kbEscape(err.message || 'The preview could not be built.')}</p>`; }
  }, delay);
}

async function kbNewArticle() {
  if (!kbState.category) return;
  if (!kbState.categories.length) { const data = await kbJson('/api/kb'); kbState.categories = data.categories; }
  kbOpenEditor({ title: '', body: '', published: false, categoryId: kbState.category.id }, true);
}

async function kbEditArticle(id) {
  try {
    const data = await kbJson(`/api/kb/articles/${id}`);
    if (!kbState.categories.length) kbState.categories = (await kbJson('/api/kb')).categories;
    kbOpenEditor({ id: data.article.id, title: data.article.title, body: data.article.body, published: data.article.published, categoryId: data.article.categoryId }, false);
  } catch (err) { showToast(err.message || 'Could not open it for editing.', 'error'); }
}

async function kbSaveArticle() {
  const host = kbHost();
  const draft = kbState.draft;
  if (!host || !draft) return;
  const title = host.querySelector('[data-kb-title]').value.trim();
  if (!title) { showToast('Give the article a title.', 'error'); host.querySelector('[data-kb-title]').focus(); return; }
  const body = host.querySelector('[data-kb-body]').value;
  const published = host.querySelector('[data-kb-published]').checked;
  try {
    if (draft.isNew) {
      const categoryId = Number(host.querySelector('[data-kb-category]').value);
      const data = await kbJson('/api/kb/articles', { method: 'POST', body: JSON.stringify({ categoryId, title, body, published }) });
      kbState.draft = null;
      await openKbArticle(data.article.id);
    } else {
      await kbJson(`/api/kb/articles/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ title, body, published }) });
      kbState.draft = null;
      await openKbArticle(draft.id);
    }
    showToast('Saved.', 'success');
  } catch (err) { showToast(err.message || 'Could not save it.', 'error'); }
}

async function kbCancelEditor() {
  const draft = kbState.draft;
  kbState.draft = null;
  if (draft && !draft.isNew && draft.id) await openKbArticle(draft.id);
  else if (kbState.category) await openKbCategory(kbState.category.id);
  else await showKnowledgeBaseHome();
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
  host.addEventListener('click', (event) => {
    const t = event.target;
    const open = t.closest('[data-kb-open-article]');
    if (open) { openKbArticle(Number(open.dataset.kbOpenArticle)); return; }
    const category = t.closest('[data-kb-open-category]');
    if (category) { openKbCategory(Number(category.dataset.kbOpenCategory)); return; }
    if (t.closest('[data-kb-home]')) { showKnowledgeBaseHome(); return; }
    if (t.closest('[data-kb-new-category]')) { kbNewCategory(); return; }
    if (t.closest('[data-kb-rename-category]')) { kbRenameCategory(); return; }
    if (t.closest('[data-kb-delete-category]')) { kbDeleteCategory(); return; }
    if (t.closest('[data-kb-new-article]')) { kbNewArticle(); return; }
    if (t.closest('[data-kb-import]')) { kbOpenImport(); return; }
    const move = t.closest('[data-kb-move]');
    if (move) { kbMove(Number(move.dataset.kbArticle), move.dataset.kbMove); return; }
    const edit = t.closest('[data-kb-edit]');
    if (edit) { kbEditArticle(Number(edit.dataset.kbEdit)); return; }
    const del = t.closest('[data-kb-delete-article]');
    if (del) { kbDeleteArticle(Number(del.dataset.kbDeleteArticle)); return; }
    if (t.closest('[data-kb-save]')) { kbSaveArticle(); return; }
    if (t.closest('[data-kb-cancel]')) { kbCancelEditor(); return; }
    if (t.closest('[data-kb-export-article]')) { kbExportArticle(); return; }
    if (t.closest('[data-kb-export-category]')) { kbExportCategory(); return; }
  });
  host.addEventListener('input', (event) => {
    if (event.target.matches('[data-kb-search]')) {
      clearTimeout(kbState.searchTimer);
      const text = event.target.value;
      kbState.searchTimer = setTimeout(() => runKbSearch(text), 250);
    } else if (event.target.matches('[data-kb-body]')) kbUpdatePreview();
  });
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
