// Knowledge Base backup and restore screens: pure markup and request building.
const test = require('node:test');
const assert = require('node:assert/strict');
const { kbBackupHtml, kbBackupRequest, kbRestoreHtml, kbRestoreRequest } = require('../src/features/kb-backup');

const outline = { categories: [
  { id: 1, title: 'Leave', articles: [{ id: 10, title: 'How <to> file', published: true }, { id: 11, title: 'Sick leave', published: false }] },
  { id: 2, title: 'Empty one', articles: [] },
] };

test('the backup screen lists every category and article with a checkbox, and the extras to include', () => {
  const html = kbBackupHtml({ outline, checkedArticles: new Set([10, 11]), checkedCategories: new Set([1, 2]), parts: { pictures: true, screens: true, history: false, comments: false } });
  assert.equal((html.match(/data-kb-bk-article="/g) || []).length, 2);
  assert.equal((html.match(/data-kb-bk-category="/g) || []).length, 2);
  assert.match(html, /How &lt;to&gt; file/);
  assert.doesNotMatch(html, /How <to> file/);
  for (const part of ['pictures', 'screens', 'history', 'comments']) assert.match(html, new RegExp(`data-kb-bk-part="${part}"`));
  assert.match(html, /data-kb-bk-part="pictures" checked/);
  assert.doesNotMatch(html, /data-kb-bk-part="history" checked/);
  assert.match(html, /data-kb-bk-run/);
  assert.match(html, /Draft/);
});

test('with nothing left unticked the request asks for everything; otherwise only what is ticked', () => {
  const parts = { pictures: true, screens: false, history: false, comments: false };
  assert.deepEqual(kbBackupRequest({ outline, checkedArticles: new Set([10, 11]), checkedCategories: new Set([1, 2]), parts }), { categoryIds: [], articleIds: [], parts });
  assert.deepEqual(kbBackupRequest({ outline, checkedArticles: new Set([11]), checkedCategories: new Set([1, 2]), parts }), { categoryIds: [2], articleIds: [11], parts });
  assert.equal(kbBackupRequest({ outline, checkedArticles: new Set(), checkedCategories: new Set(), parts }), null, 'nothing chosen: nothing to back up');
});

const preview = { exportedAt: '2026-11-20T01:00:00.000Z', parts: { pictures: true, screens: true, history: false, comments: true }, pictureCount: 3, categories: [
  { key: 'c1', title: 'Leave', exists: true, articles: [{ key: 'a1', title: 'File a leave', published: true, exists: true }, { key: 'a2', title: 'New one', published: false, exists: false }] },
] };

test('the restore screen lists what the file holds, asks what to do with articles that already exist, and offers only the extras the file has', () => {
  const html = kbRestoreHtml({ preview, chosen: new Map([['a1', 'skip'], ['a2', 'skip']]), parts: { pictures: true, screens: true, history: true, comments: true }, fileName: 'kb.json' });
  assert.match(html, /kb\.json/);
  assert.equal((html.match(/data-kb-rs-article="/g) || []).length, 2);
  assert.equal((html.match(/data-kb-rs-action="a1"/g) || []).length, 1, 'only an existing article gets the choice');
  assert.equal(/data-kb-rs-action="a2"/.test(html), false);
  assert.match(html, /Replace the text/);
  assert.match(html, /data-kb-rs-part="pictures"/);
  assert.equal(/data-kb-rs-part="history"/.test(html), false, 'the file has no history to bring back');
  assert.match(html, /Restore 2 articles/);
});

test('the restore request carries only the ticked articles, each with its action', () => {
  const body = kbRestoreRequest({ pkg: { format: 'x' }, preview, chosen: new Map([['a1', 'replace']]), parts: { pictures: true, screens: false, history: true, comments: true } });
  assert.deepEqual(body.articles, [{ key: 'a1', action: 'replace' }]);
  assert.deepEqual(body.parts, { pictures: true, screens: false, history: false, comments: true }, 'a part the file does not have is not asked for');
  assert.deepEqual(body.package, { format: 'x' });
  assert.match(kbRestoreHtml({ preview, chosen: new Map(), parts: {}, fileName: 'f' }), /disabled/);
});
