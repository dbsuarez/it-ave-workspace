// Knowledge Base markup: home, category, article, search results, the editor and the import preview. Pure: data in, HTML out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { kbHomeHtml, kbCategoryHtml, kbArticleHtml, kbSearchResultsHtml, kbEditorHtml, kbImportHtml, kbDateText } = require('../src/features/kb-view');

const categories = [{ id: 1, title: 'Leave', articleCount: 3, draftCount: 1 }, { id: 2, title: 'Employee <Handbook>', articleCount: 12, draftCount: 0 }];

test('the home screen has a search box and one card per category, with how many articles it holds', () => {
  const html = kbHomeHtml({ categories, canManage: false });
  assert.match(html, /data-kb-search/);
  assert.equal((html.match(/data-kb-open-category="/g) || []).length, 2);
  assert.match(html, /3 articles/);
  assert.match(html, /12 articles/);
  assert.match(html, /Employee &lt;Handbook&gt;/, 'titles are escaped');
});

test('an employee gets no management buttons and no draft counts; HR gets New category and sees the drafts', () => {
  const employee = kbHomeHtml({ categories: categories.map(({ draftCount, ...rest }) => rest), canManage: false });
  assert.equal(/data-kb-new-category/.test(employee), false);
  assert.equal(/draft/i.test(employee), false);
  const hr = kbHomeHtml({ categories, canManage: true });
  assert.match(hr, /data-kb-new-category/);
  assert.match(hr, /1 draft/);
});

test('an empty home says so, differently for HR and for employees', () => {
  assert.match(kbHomeHtml({ categories: [], canManage: false }), /nothing here yet/i);
  assert.match(kbHomeHtml({ categories: [], canManage: true }), /New category/);
});

const articles = [
  { id: 10, title: 'Welcome', published: true, updatedAt: '2026-11-18T10:00:00Z', updatedByName: 'Hana Reyes' },
  { id: 11, title: 'Working hours', published: false, updatedAt: '2026-11-19T10:00:00Z', updatedByName: 'kb-boss' },
];

test('a category lists its articles in order as a table of contents, with when each was last updated', () => {
  const html = kbCategoryHtml({ category: { id: 2, title: 'Handbook' }, articles: articles.slice(0, 1), canManage: false, canExport: true });
  assert.match(html, /Handbook/);
  assert.match(html, /1\./);
  assert.match(html, /data-kb-open-article="10"/);
  assert.match(html, /Updated Nov 18, 2026/);
  assert.match(html, /data-kb-export-category/);
  assert.equal(/data-kb-move/.test(html), false, 'employees cannot reorder');
  assert.equal(/Draft/.test(html), false);
});

test('HR sees drafts marked, can move articles, add, import, rename and delete', () => {
  const html = kbCategoryHtml({ category: { id: 2, title: 'Handbook' }, articles, canManage: true, canExport: false });
  assert.match(html, /Draft/);
  assert.match(html, /data-kb-move="up"/);
  assert.match(html, /data-kb-move="down"/);
  for (const hook of ['data-kb-new-article', 'data-kb-import', 'data-kb-rename-category', 'data-kb-delete-category']) assert.match(html, new RegExp(hook));
  assert.equal(/data-kb-export-category/.test(html), false, 'no export outside the desktop app');
  assert.match(kbCategoryHtml({ category: { id: 2, title: 'Handbook' }, articles: [], canManage: false }), /No articles yet/);
});

test('an article shows its title, category, last updated date and who, the text, and previous and next links', () => {
  const html = kbArticleHtml({
    article: { id: 10, title: 'How do I file a leave?', categoryId: 1, categoryTitle: 'Leave', published: true, updatedAt: '2026-11-19T10:00:00Z', updatedByName: 'Hana Reyes' },
    bodyHtml: '<p>Open People.</p>', siblings: { previous: { id: 9, title: 'Welcome' }, next: { id: 11, title: 'Sick leave' } }, canManage: false, canExport: true,
  });
  assert.match(html, /How do I file a leave\?/);
  assert.match(html, /Updated Nov 19, 2026 by Hana Reyes/);
  assert.match(html, /<p>Open People\.<\/p>/);
  assert.match(html, /data-kb-open-article="9"/);
  assert.match(html, /data-kb-open-article="11"/);
  assert.match(html, /data-kb-open-category="1"/);
  assert.match(html, /data-kb-export-article/);
  assert.equal(/data-kb-edit/.test(html), false);
  const hr = kbArticleHtml({ article: { id: 10, title: 'X', categoryId: 1, categoryTitle: 'Leave', published: false, updatedAt: '2026-11-19T10:00:00Z', updatedByName: null }, bodyHtml: '', siblings: {}, canManage: true });
  assert.match(hr, /data-kb-edit="10"/);
  assert.match(hr, /data-kb-delete-article="10"/);
  assert.match(hr, /Draft/);
  assert.equal(/ by /.test(hr), false, 'no name: no "by"');
});

test('search results show the title, the category, a snippet and the date; no results says so', () => {
  const html = kbSearchResultsHtml({ query: 'leave <x>', results: [{ id: 10, title: 'How do I file a leave?', categoryTitle: 'Leave', snippet: '…press <b>Request</b>…', updatedAt: '2026-11-19T10:00:00Z', published: true }] });
  assert.match(html, /data-kb-open-article="10"/);
  assert.match(html, /Leave/);
  assert.match(html, /&lt;b&gt;Request&lt;\/b&gt;/, 'the snippet is escaped');
  assert.match(html, /leave &lt;x&gt;/);
  assert.match(kbSearchResultsHtml({ query: 'zzz', results: [] }), /No articles found/);
});

test('the editor has a title, the Markdown, a published box and a preview area; a new article asks which category', () => {
  const html = kbEditorHtml({ draft: { id: 10, title: 'Policy', body: '# Hi', published: true, categoryId: 1 }, categories: categories.slice(0, 2), isNew: false });
  assert.match(html, /data-kb-title/);
  assert.match(html, /data-kb-body/);
  assert.match(html, /# Hi/);
  assert.match(html, /data-kb-published[^>]*checked/);
  assert.match(html, /data-kb-preview/);
  assert.match(html, /data-kb-save/);
  const fresh = kbEditorHtml({ draft: { title: '', body: '', published: false, categoryId: 2 }, categories, isNew: true });
  assert.match(fresh, /data-kb-category/);
  assert.match(fresh, /<option value="2" selected>/);
  assert.equal(/data-kb-published[^>]*checked/.test(fresh), false);
});

test('the import dialog has a paste box, the split level, and previews the articles it would make', () => {
  const html = kbImportHtml({ text: '# One\nx', level: 1, publish: false, preview: { articles: [{ title: 'One', body: 'x' }, { title: 'Two', body: '' }], preamble: 'Intro text', skipped: 0 }, categoryTitle: 'Handbook' });
  assert.match(html, /data-kb-import-text/);
  assert.match(html, /data-kb-import-level/);
  assert.match(html, /2 articles/);
  assert.match(html, /One/);
  assert.match(html, /Intro text|introduction/i);
  assert.match(html, /data-kb-import-save/);
  assert.match(kbImportHtml({ text: '', level: 1, publish: false, preview: { articles: [], preamble: '', skipped: 0 }, categoryTitle: 'H' }), /Paste/);
  assert.match(kbImportHtml({ text: 'x', level: 1, publish: false, preview: { articles: [{ title: 'A', body: '' }], preamble: '', skipped: 5 }, categoryTitle: 'H' }), /5 more/);
});

test('dates read like "Nov 19, 2026" and a bad date is empty', () => {
  assert.equal(kbDateText('2026-11-19T10:00:00Z'), 'Nov 19, 2026');
  assert.equal(kbDateText('nonsense'), '');
  assert.equal(kbDateText(null), '');
});
