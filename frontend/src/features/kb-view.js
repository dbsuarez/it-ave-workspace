// IT Avenue Workspace - Knowledge Base: the markup for its screens. Pure: data in, HTML out, every value escaped
// (docs/superpowers/specs/2026-11-19-knowledge-base-design.md). The screen itself (loading, saving, importing) is knowledge-base.js.

const kbEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kbPlural = (n, word) => `${Number(n)} ${word}${Number(n) === 1 ? '' : 's'}`;

// "Nov 19, 2026" (UTC, so every computer reads the same day), or '' when there is no date.
function kbDateText(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const kbUpdated = (item) => {
  const when = kbDateText(item.updatedAt);
  if (!when) return '';
  return `Updated ${kbEscape(when)}${item.updatedByName ? ` by ${kbEscape(item.updatedByName)}` : ''}`;
};

const KB_SEARCH_BOX = '<input type="search" class="kb-search" data-kb-search placeholder="Search the Knowledge Base" aria-label="Search the Knowledge Base" autocomplete="off" maxlength="100">';

// categories: [{ id, title, articleCount, draftCount? }]
function kbHomeHtml({ categories, canManage }) {
  const cards = categories.map((category) => `<button type="button" class="kb-card" data-kb-open-category="${Number(category.id)}"><strong>${kbEscape(category.title)}</strong><span>${kbPlural(category.articleCount, 'article')}</span>${canManage && category.draftCount ? `<em class="kb-draft-count">${kbPlural(category.draftCount, 'draft')}</em>` : ''}</button>`).join('');
  const empty = categories.length ? '' : `<p class="kb-empty">${canManage ? 'No categories yet. Press New category to start the Knowledge Base.' : 'There is nothing here yet. HR will add answers soon.'}</p>`;
  return `<div class="kb-home"><div class="kb-toolbar">${KB_SEARCH_BOX}${canManage ? '<button type="button" class="btn primary" data-kb-new-category>New category</button>' : ''}</div><div class="kb-search-results" data-kb-results hidden></div><div class="kb-cards" data-kb-cards>${cards}</div>${empty}</div>`;
}

// articles: [{ id, title, published, updatedAt, updatedByName }]; canExport: the desktop app can save a PDF
function kbCategoryHtml({ category, articles, canManage, canExport = false }) {
  const rows = articles.map((article, index) => `<li class="kb-toc-row"><button type="button" class="kb-toc-main" data-kb-open-article="${Number(article.id)}"><span class="kb-toc-number">${index + 1}.</span><span class="kb-toc-title">${kbEscape(article.title)}</span>${article.published ? '' : '<span class="kb-badge">Draft</span>'}<span class="kb-toc-meta">${kbUpdated(article)}</span></button>${canManage ? `<span class="kb-move"><button type="button" class="btn small" data-kb-move="up" data-kb-article="${Number(article.id)}" aria-label="Move up"${index === 0 ? ' disabled' : ''}>&uarr;</button><button type="button" class="btn small" data-kb-move="down" data-kb-article="${Number(article.id)}" aria-label="Move down"${index === articles.length - 1 ? ' disabled' : ''}>&darr;</button></span>` : ''}</li>`).join('');
  const actions = [
    canExport && articles.length ? '<button type="button" class="btn" data-kb-export-category>Save as PDF</button>' : '',
    canManage ? '<button type="button" class="btn" data-kb-import>Import</button><button type="button" class="btn" data-kb-rename-category>Rename</button><button type="button" class="btn danger" data-kb-delete-category>Delete</button><button type="button" class="btn primary" data-kb-new-article>New article</button>' : '',
  ].join('');
  return `<div class="kb-category" data-kb-category="${Number(category.id)}"><div class="kb-crumbs"><button type="button" class="kb-link" data-kb-home>Knowledge Base</button></div><div class="kb-heading"><h2>${kbEscape(category.title)}</h2><div class="kb-actions">${actions}</div></div>${articles.length ? `<ol class="kb-toc">${rows}</ol>` : '<p class="kb-empty">No articles yet.</p>'}</div>`;
}

// Find in this article: a box, the match count, and previous / next.
function kbFindBarHtml() {
  return '<div class="kb-find-bar" role="search"><input type="search" class="kb-find-input" data-kb-find-input placeholder="Find in this article" aria-label="Find in this article" maxlength="100" autocomplete="off"><span class="kb-find-count" data-kb-find-count aria-live="polite"></span><button type="button" class="btn small" data-kb-find-prev aria-label="Previous match" title="Previous match (Shift+Enter)">&uarr;</button><button type="button" class="btn small" data-kb-find-next aria-label="Next match" title="Next match (Enter)">&darr;</button></div>';
}

// The floating "On this page" list: only for an article with two or more headings. outline: [{ id, level, title }]
function kbTocHtml(outline) {
  if (!Array.isArray(outline) || outline.length < 2) return '';
  const items = outline.map((item) => `<li><button type="button" class="kb-toc-item kb-toc-level-${Math.min(Math.max(Number(item.level) || 1, 1), 4)}" data-kb-toc-item="${kbEscape(item.id)}">${kbEscape(item.title)}</button></li>`).join('');
  return `<nav class="kb-toc-float" data-kb-toc aria-label="On this page"><button type="button" class="kb-toc-toggle" data-kb-toc-toggle aria-expanded="true"><span>On this page</span><span class="kb-toc-caret" aria-hidden="true">&#9662;</span></button><ol class="kb-toc-list">${items}</ol></nav>`;
}

// bodyHtml: the article text already turned into safe HTML by the reading view; siblings: { previous, next } each { id, title } or null
function kbArticleHtml({ article, bodyHtml, siblings = {}, canManage, canExport = false, outline = [] }) {
  const nav = (item, label) => (item ? `<button type="button" class="kb-nav" data-kb-open-article="${Number(item.id)}"><small>${label}</small><span>${kbEscape(item.title)}</span></button>` : '<span></span>');
  const actions = [
    canExport ? '<button type="button" class="btn" data-kb-export-article>Save as PDF</button>' : '',
    canManage ? `<button type="button" class="btn primary" data-kb-edit="${Number(article.id)}">Edit text</button><button type="button" class="btn" data-kb-details="${Number(article.id)}">Details</button><button type="button" class="btn danger" data-kb-delete-article="${Number(article.id)}">Delete</button>` : '',
  ].join('');
  return `<article class="kb-article" data-kb-article-id="${Number(article.id)}"><div class="kb-crumbs"><button type="button" class="kb-link" data-kb-home>Knowledge Base</button> / <button type="button" class="kb-link" data-kb-open-category="${Number(article.categoryId)}">${kbEscape(article.categoryTitle)}</button></div><div class="kb-heading"><h2>${kbEscape(article.title)}${article.published ? '' : ' <span class="kb-badge">Draft</span>'}</h2><div class="kb-actions">${actions}</div></div><p class="kb-updated">${kbUpdated(article)}</p>${kbFindBarHtml()}${kbTocHtml(outline)}<div class="kb-body cv-body" data-kb-article-body>${bodyHtml}</div><div class="kb-siblings">${nav(siblings.previous, 'Previous')}${nav(siblings.next, 'Next')}</div></article>`;
}

function kbSearchResultsHtml({ query, results }) {
  if (!results.length) return `<p class="kb-empty">No articles found for "${kbEscape(query)}".</p>`;
  return `<p class="kb-result-count">${kbPlural(results.length, 'result')} for "${kbEscape(query)}"</p><ul class="kb-results">${results.map((item) => `<li><button type="button" class="kb-result" data-kb-open-article="${Number(item.id)}"><strong>${kbEscape(item.title)}</strong>${item.published === false ? '<span class="kb-badge">Draft</span>' : ''}<small>${kbEscape(item.categoryTitle)}${kbDateText(item.updatedAt) ? ` &middot; ${kbEscape(kbDateText(item.updatedAt))}` : ''}</small><span class="kb-snippet">${kbEscape(item.snippet)}</span></button></li>`).join('')}</ul>`;
}

// The article's details (not its text, which is written in the Canvas editor): title, category, published, and the screens it helps with.
// draft: { id?, title, published, categoryId, screens: [keys] }; screenOptions: [{ key, label }]
function kbDetailsHtml({ draft, categories, screenOptions = [], isNew }) {
  const chosen = new Set(draft.screens || []);
  const categoryOptions = categories.map((c) => `<option value="${Number(c.id)}"${Number(c.id) === Number(draft.categoryId) ? ' selected' : ''}>${kbEscape(c.title)}</option>`).join('');
  const screens = screenOptions.map((s) => `<label class="kb-screen-option"><input type="checkbox" data-kb-screen="${kbEscape(s.key)}"${chosen.has(s.key) ? ' checked' : ''}> ${kbEscape(s.label)}</label>`).join('');
  return `<div class="modal-header"><h3>${isNew ? 'New article' : 'Article details'}</h3><button class="modal-close" type="button" data-kb-details-close aria-label="Close">&times;</button></div><div class="modal-body"><label class="poll-field-label" for="kb-title">Title</label><input id="kb-title" class="poll-field" data-kb-title type="text" maxlength="160" placeholder="For example: How do I file a leave?" value="${kbEscape(draft.title)}"><label class="poll-field-label" for="kb-category">Category</label><select id="kb-category" class="poll-field" data-kb-category>${categoryOptions}</select><label class="kb-publish"><input type="checkbox" data-kb-published${draft.published ? ' checked' : ''}> Published (employees can see it)</label><div class="poll-field-label">Show a Help link for this article on these screens</div><div class="kb-screen-options">${screens}</div>${isNew ? '<p class="drawing-share-note">After you create it you write the text in the Canvas editor, with pictures, headings and history.</p>' : ''}</div><div class="modal-footer"><button type="button" class="btn" data-kb-details-close>Cancel</button><button type="button" class="btn primary" data-kb-details-save>${isNew ? 'Create and write' : 'Save'}</button></div>`;
}

// preview: from splitMarkdownIntoArticles: { articles, preamble, skipped }
function kbImportHtml({ text, level, publish, preview, categoryTitle }) {
  const list = preview.articles.length
    ? `<p class="kb-result-count">${kbPlural(preview.articles.length, 'article')} will be added to ${kbEscape(categoryTitle)}${preview.skipped ? `; ${preview.skipped} more are left out (an import is at most 200 articles)` : ''}</p><ol class="kb-import-list">${preview.articles.map((a) => `<li><strong>${kbEscape(a.title)}</strong><small>${kbPlural(String(a.body || '').length, 'character')}</small></li>`).join('')}</ol>${preview.preamble ? '<p class="kb-hint">The text before the first heading is kept as an article called Introduction.</p>' : ''}`
    : '<p class="kb-hint">Paste the text above. Each heading becomes an article, and you can check the list here before anything is saved.</p>';
  return `<div class="modal-header"><h3>Import into ${kbEscape(categoryTitle)}</h3><button class="modal-close" type="button" data-kb-import-close aria-label="Close">&times;</button></div><div class="modal-body"><p class="drawing-share-note">Paste Markdown text, for example a handbook your other tool turned into text. Pick which headings start a new article.</p><label class="poll-field-label" for="kb-import-text">Paste the text</label><textarea id="kb-import-text" class="kb-body-input" data-kb-import-text placeholder="# Welcome&#10;...&#10;# Working hours&#10;...">${kbEscape(text)}</textarea><label class="poll-field-label" for="kb-import-level">Start a new article at</label><select id="kb-import-level" class="poll-field" data-kb-import-level><option value="1"${Number(level) === 1 ? ' selected' : ''}>each # heading</option><option value="2"${Number(level) === 2 ? ' selected' : ''}>each ## heading</option></select><label class="kb-publish"><input type="checkbox" data-kb-import-publish${publish ? ' checked' : ''}> Publish them now (otherwise they are saved as drafts)</label>${list}</div><div class="modal-footer"><button type="button" class="btn" data-kb-import-close>Cancel</button><button type="button" class="btn primary" data-kb-import-save${preview.articles.length ? '' : ' disabled'}>Add ${kbPlural(preview.articles.length, 'article')}</button></div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { kbHomeHtml, kbCategoryHtml, kbArticleHtml, kbSearchResultsHtml, kbDetailsHtml, kbImportHtml, kbDateText };
}
