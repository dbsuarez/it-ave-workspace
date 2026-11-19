// Knowledge Base import: pasted Markdown (for example a handbook turned into text) split into articles at its headings. Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitMarkdownIntoArticles } = require('../src/features/kb-import');

const handbook = [
  '# Welcome', 'Hello and welcome to IT Avenue.', '',
  '## Mission', 'We build things.', '',
  '# Working hours', 'Monday to Friday.', '',
  '## Breaks', '- Lunch', '- Coffee', '',
  '### Overtime', 'Ask your manager.',
].join('\n');

test('split at # headings: each heading starts an article and the deeper headings stay inside it', () => {
  const { articles } = splitMarkdownIntoArticles(handbook, { level: 1 });
  assert.deepEqual(articles.map((a) => a.title), ['Welcome', 'Working hours']);
  assert.match(articles[0].body, /Hello and welcome/);
  assert.match(articles[0].body, /## Mission/);
  assert.match(articles[1].body, /### Overtime/);
  assert.equal(articles[0].body.includes('# Welcome'), false, 'the title is not repeated in the body');
});

test('split at ## headings instead', () => {
  const { articles, preamble } = splitMarkdownIntoArticles(handbook, { level: 2 });
  assert.deepEqual(articles.map((a) => a.title), ['Mission', 'Breaks']);
  assert.match(preamble, /# Welcome/, 'what comes before the first ## is kept as the introduction');
  assert.match(articles[1].body, /### Overtime/);
});

test('text before the first heading becomes an Introduction article when asked for', () => {
  const text = 'Some opening words.\n\n# One\nBody one';
  const split = splitMarkdownIntoArticles(text, { level: 1 });
  assert.equal(split.preamble, 'Some opening words.');
  assert.deepEqual(splitMarkdownIntoArticles(text, { level: 1, introTitle: 'Introduction' }).articles.map((a) => a.title), ['Introduction', 'One']);
});

test('headings inside code fences are not headings', () => {
  const text = '# Real\n```\n# not a heading\n```\nafter\n# Second\nx';
  const { articles } = splitMarkdownIntoArticles(text, { level: 1 });
  assert.deepEqual(articles.map((a) => a.title), ['Real', 'Second']);
  assert.match(articles[0].body, /# not a heading/);
});

test('no heading at the chosen level gives one article with a fallback title; empty text gives none', () => {
  assert.deepEqual(splitMarkdownIntoArticles('just words', { level: 1, fallbackTitle: 'Imported text' }).articles, [{ title: 'Imported text', body: 'just words' }]);
  assert.deepEqual(splitMarkdownIntoArticles('   \n ', { level: 1 }).articles, []);
});

test('titles lose trailing # marks and spaces, are cut at 160 characters, and Windows line endings are fine', () => {
  const { articles } = splitMarkdownIntoArticles(`#   Leave policy   ##\r\nBody\r\n# ${'x'.repeat(200)}\r\nMore`, { level: 1 });
  assert.equal(articles[0].title, 'Leave policy');
  assert.equal(articles[0].body, 'Body');
  assert.equal(articles[1].title.length, 160);
});

test('more than 200 articles are reported, and the first 200 are kept', () => {
  const text = Array.from({ length: 205 }, (_, i) => `# Chapter ${i + 1}\nText`).join('\n');
  const split = splitMarkdownIntoArticles(text, { level: 1 });
  assert.equal(split.articles.length, 200);
  assert.equal(split.skipped, 5);
});
