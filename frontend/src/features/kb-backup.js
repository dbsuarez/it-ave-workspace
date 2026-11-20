// IT Avenue Workspace - Knowledge Base backup and restore (docs/superpowers/specs/2026-11-20-knowledge-base-backup-design.md).
// Backup: tick the categories and articles and the extras (pictures, Help links, history, comments), and one file is saved.
// Restore: pick such a file, see what is in it, tick the articles to bring back and say what to do with one that already exists.
// The markup and the requests are pure and tested (frontend/test/kb-backup.test.js); the dialog wiring is at the end of this file.

const KB_BK_PARTS = [
  ['pictures', 'Pictures'],
  ['screens', 'Help links (the screens an article helps with)'],
  ['history', 'Version history'],
  ['comments', 'Comments'],
];
const KB_BK_ACTIONS = [['skip', 'Skip it (keep what is there)'], ['replace', 'Replace the text (the old text stays in History)'], ['copy', 'Add a copy']];

const kbBkEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kbBkPlural = (n, word) => `${Number(n)} ${word}${Number(n) === 1 ? '' : 's'}`;

// outline: { categories: [{ id, title, articles: [{ id, title, published }] }] }
function kbBackupHtml({ outline, checkedArticles, checkedCategories, parts }) {
  const tree = outline.categories.map((category) => {
    const articles = category.articles.map((article) => `<li><label><input type="checkbox" data-kb-bk-article="${Number(article.id)}" data-kb-bk-in="${Number(category.id)}"${checkedArticles.has(article.id) ? ' checked' : ''}> ${kbBkEscape(article.title)}${article.published ? '' : ' <em class="kb-draft-count">Draft</em>'}</label></li>`).join('');
    return `<li class="kb-bk-category"><label><input type="checkbox" data-kb-bk-category="${Number(category.id)}"${checkedCategories.has(category.id) ? ' checked' : ''}> <strong>${kbBkEscape(category.title)}</strong> <small>${kbBkPlural(category.articles.length, 'article')}</small></label>${articles ? `<ul class="kb-bk-articles">${articles}</ul>` : ''}</li>`;
  }).join('');
  const extras = KB_BK_PARTS.map(([key, label]) => `<label class="kb-publish"><input type="checkbox" data-kb-bk-part="${key}"${parts[key] ? ' checked' : ''}> ${label}</label>`).join('');
  return `<div class="modal-header"><h3>Back up the Knowledge Base</h3><button class="modal-close" type="button" data-kb-bk-close aria-label="Close">&times;</button></div><div class="modal-body"><p class="drawing-share-note">Tick what to save. Everything goes into one file that you keep somewhere safe and can restore from later.</p><div class="kb-bk-bar"><button type="button" class="btn small" data-kb-bk-all>Select all</button><button type="button" class="btn small" data-kb-bk-none>Select none</button></div><ul class="kb-bk-tree">${tree || '<li class="kb-hint">There is nothing to back up yet.</li>'}</ul><p class="poll-field-label">Also include</p>${extras}</div><div class="modal-footer"><button type="button" class="btn" data-kb-bk-close>Cancel</button><button type="button" class="btn primary" data-kb-bk-run>Download backup</button></div>`;
}

// Everything ticked asks for everything (an empty choice); otherwise the ticked articles, and the ticked categories that have no articles.
// null when nothing is ticked.
function kbBackupRequest({ outline, checkedArticles, checkedCategories, parts }) {
  const allArticles = outline.categories.flatMap((category) => category.articles.map((article) => article.id));
  const everything = allArticles.every((id) => checkedArticles.has(id)) && outline.categories.every((category) => checkedCategories.has(category.id));
  const articleIds = allArticles.filter((id) => checkedArticles.has(id));
  const categoryIds = outline.categories.filter((category) => !category.articles.length && checkedCategories.has(category.id)).map((category) => category.id);
  if (!everything && !articleIds.length && !categoryIds.length) return null;
  return everything ? { categoryIds: [], articleIds: [], parts: { ...parts } } : { categoryIds, articleIds, parts: { ...parts } };
}

// preview: what the server said about the file. chosen: Map(article key -> action) for the ticked articles.
function kbRestoreHtml({ preview, chosen, parts, fileName }) {
  const tree = preview.categories.map((category) => {
    const articles = category.articles.map((article) => {
      const picker = article.exists
        ? `<select data-kb-rs-action="${kbBkEscape(article.key)}" aria-label="What to do with ${kbBkEscape(article.title)}, which already exists">${KB_BK_ACTIONS.map(([value, label]) => `<option value="${value}"${chosen.get(article.key) === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`
        : '<small class="kb-hint">New</small>';
      return `<li><label><input type="checkbox" data-kb-rs-article="${kbBkEscape(article.key)}"${chosen.has(article.key) ? ' checked' : ''}> ${kbBkEscape(article.title)}${article.published ? '' : ' <em class="kb-draft-count">Draft</em>'}</label>${picker}</li>`;
    }).join('');
    return `<li class="kb-bk-category"><strong>${kbBkEscape(category.title)}</strong> ${category.exists ? '' : '<small class="kb-hint">New category</small>'}${articles ? `<ul class="kb-bk-articles">${articles}</ul>` : ''}</li>`;
  }).join('');
  const extras = KB_BK_PARTS.filter(([key]) => preview.parts[key]).map(([key, label]) => `<label class="kb-publish"><input type="checkbox" data-kb-rs-part="${key}"${parts[key] !== false ? ' checked' : ''}> ${label}</label>`).join('');
  const count = chosen.size;
  const made = preview.exportedAt ? ` Saved ${kbBkEscape(String(preview.exportedAt).slice(0, 10))}.` : '';
  return `<div class="modal-header"><h3>Restore the Knowledge Base</h3><button class="modal-close" type="button" data-kb-bk-close aria-label="Close">&times;</button></div><div class="modal-body"><p class="drawing-share-note"><strong>${kbBkEscape(fileName)}</strong>.${made} Tick the articles to bring back. Nothing that exists is changed unless you choose to replace it.</p><div class="kb-bk-bar"><button type="button" class="btn small" data-kb-rs-all>Select all</button><button type="button" class="btn small" data-kb-rs-none>Select none</button></div><ul class="kb-bk-tree">${tree || '<li class="kb-hint">This file has no articles.</li>'}</ul>${extras ? `<p class="poll-field-label">Bring back also</p>${extras}` : ''}</div><div class="modal-footer"><button type="button" class="btn" data-kb-bk-close>Cancel</button><button type="button" class="btn primary" data-kb-rs-run${count ? '' : ' disabled'}>Restore ${kbBkPlural(count, 'article')}</button></div>`;
}

function kbRestoreRequest({ pkg, preview, chosen, parts }) {
  const articles = preview.categories.flatMap((category) => category.articles).filter((article) => chosen.has(article.key)).map((article) => ({ key: article.key, action: chosen.get(article.key) }));
  const asked = {};
  for (const [key] of KB_BK_PARTS) asked[key] = Boolean(preview.parts[key]) && parts[key] !== false;
  return { package: pkg, articles, parts: asked };
}

// ---- the dialogs ------------------------------------------------------------------------------------------------------

const kbBk = { outline: null, articles: new Set(), categories: new Set(), parts: { pictures: true, screens: true, history: false, comments: false }, pkg: null, preview: null, chosen: new Map(), restoreParts: {}, fileName: '' };
const kbBkModal = () => document.getElementById('kb-backup-modal');

function kbBkRenderBackup() {
  kbBkModal().innerHTML = kbBackupHtml({ outline: kbBk.outline, checkedArticles: kbBk.articles, checkedCategories: kbBk.categories, parts: kbBk.parts });
}

async function kbOpenBackup() {
  try {
    kbBk.outline = await kbJson('/api/kb-backup/outline');
  } catch (err) { showToast(err.message || 'Could not load the Knowledge Base.', 'error'); return; }
  kbBk.articles = new Set(kbBk.outline.categories.flatMap((category) => category.articles.map((article) => article.id)));
  kbBk.categories = new Set(kbBk.outline.categories.map((category) => category.id));
  kbBkRenderBackup();
  openSettingsModal(kbBkModal());
}

async function kbRunBackup() {
  const request = kbBackupRequest({ outline: kbBk.outline, checkedArticles: kbBk.articles, checkedCategories: kbBk.categories, parts: kbBk.parts });
  if (!request) { showToast('Tick something to back up first.', 'error'); return; }
  const button = kbBkModal().querySelector('[data-kb-bk-run]');
  button.disabled = true; button.textContent = 'Preparing…';
  try {
    const response = await api('/api/kb-backup/export', { method: 'POST', body: JSON.stringify(request) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not make the backup.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `knowledge-base-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    closeSettingsModal();
    showToast('Backup saved to your downloads.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not make the backup.', 'error');
    button.disabled = false; button.textContent = 'Download backup';
  }
}

function kbBkRenderRestore() {
  kbBkModal().innerHTML = kbRestoreHtml({ preview: kbBk.preview, chosen: kbBk.chosen, parts: kbBk.restoreParts, fileName: kbBk.fileName });
}

function kbOpenRestore() {
  const picker = document.createElement('input');
  picker.type = 'file'; picker.accept = '.json,application/json';
  picker.addEventListener('change', async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    try {
      kbBk.pkg = JSON.parse(await file.text());
      kbBk.preview = await kbJson('/api/kb-backup/preview', { method: 'POST', body: JSON.stringify({ package: kbBk.pkg }) });
    } catch (err) { showToast(err instanceof SyntaxError ? 'That file is not a Knowledge Base backup.' : (err.message || 'Could not read that file.'), 'error'); return; }
    kbBk.fileName = file.name;
    kbBk.chosen = new Map(kbBk.preview.categories.flatMap((category) => category.articles).map((article) => [article.key, 'skip']));
    kbBk.restoreParts = {};
    kbBkRenderRestore();
    openSettingsModal(kbBkModal());
  });
  picker.click();
}

async function kbRunRestore() {
  const button = kbBkModal().querySelector('[data-kb-rs-run]');
  button.disabled = true; button.textContent = 'Restoring…';
  try {
    const result = await kbJson('/api/kb-backup/restore', { method: 'POST', body: JSON.stringify(kbRestoreRequest({ pkg: kbBk.pkg, preview: kbBk.preview, chosen: kbBk.chosen, parts: kbBk.restoreParts })) });
    closeSettingsModal();
    const bits = [[result.created, 'added'], [result.replaced, 'replaced'], [result.copied, 'copied'], [result.skipped, 'skipped']].filter(([n]) => n).map(([n, word]) => `${n} ${word}`);
    showToast(`Restored: ${bits.join(', ') || 'nothing to do'}.`, 'success');
    kbBk.pkg = null;
    if (typeof showKnowledgeBaseHome === 'function') showKnowledgeBaseHome();
  } catch (err) {
    showToast(err.message || 'Could not restore.', 'error');
    button.disabled = false; button.textContent = 'Restore';
  }
}

function setupKbBackup() {
  const modal = kbBkModal();
  if (!modal) return;
  modal.addEventListener('click', (event) => {
    const t = event.target;
    if (t.closest('[data-kb-bk-close]')) { closeSettingsModal(); return; }
    if (t.closest('[data-kb-bk-run]')) { kbRunBackup(); return; }
    if (t.closest('[data-kb-rs-run]')) { kbRunRestore(); return; }
    if (t.closest('[data-kb-bk-all]') || t.closest('[data-kb-bk-none]')) {
      const all = Boolean(t.closest('[data-kb-bk-all]'));
      kbBk.articles = new Set(all ? kbBk.outline.categories.flatMap((category) => category.articles.map((article) => article.id)) : []);
      kbBk.categories = new Set(all ? kbBk.outline.categories.map((category) => category.id) : []);
      kbBkRenderBackup();
      return;
    }
    if (t.closest('[data-kb-rs-all]') || t.closest('[data-kb-rs-none]')) {
      const all = Boolean(t.closest('[data-kb-rs-all]'));
      kbBk.chosen = new Map(all ? kbBk.preview.categories.flatMap((category) => category.articles).map((article) => [article.key, kbBk.chosen.get(article.key) || 'skip']) : []);
      kbBkRenderRestore();
    }
  });
  modal.addEventListener('change', (event) => {
    const t = event.target;
    if (t.matches('[data-kb-bk-category]')) {
      const id = Number(t.dataset.kbBkCategory);
      const category = kbBk.outline.categories.find((entry) => entry.id === id);
      (t.checked ? kbBk.categories.add(id) : kbBk.categories.delete(id));
      for (const article of category.articles) (t.checked ? kbBk.articles.add(article.id) : kbBk.articles.delete(article.id));
      kbBkRenderBackup();
    } else if (t.matches('[data-kb-bk-article]')) {
      const id = Number(t.dataset.kbBkArticle);
      (t.checked ? kbBk.articles.add(id) : kbBk.articles.delete(id));
      const category = kbBk.outline.categories.find((entry) => entry.id === Number(t.dataset.kbBkIn));
      (category.articles.every((article) => kbBk.articles.has(article.id)) ? kbBk.categories.add(category.id) : kbBk.categories.delete(category.id));
      kbBkRenderBackup();
    } else if (t.matches('[data-kb-bk-part]')) {
      kbBk.parts[t.dataset.kbBkPart] = t.checked;
    } else if (t.matches('[data-kb-rs-article]')) {
      const key = t.dataset.kbRsArticle;
      const select = modal.querySelector(`[data-kb-rs-action="${CSS.escape(key)}"]`);
      if (t.checked) kbBk.chosen.set(key, select ? select.value : 'skip'); else kbBk.chosen.delete(key);
      kbBkRenderRestore();
    } else if (t.matches('[data-kb-rs-action]')) {
      if (kbBk.chosen.has(t.dataset.kbRsAction)) kbBk.chosen.set(t.dataset.kbRsAction, t.value);
    } else if (t.matches('[data-kb-rs-part]')) {
      kbBk.restoreParts[t.dataset.kbRsPart] = t.checked;
    }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { kbBackupHtml, kbBackupRequest, kbRestoreHtml, kbRestoreRequest };
}
