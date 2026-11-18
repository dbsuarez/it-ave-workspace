const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helpSections, helpFilter, helpTocHtml, helpBodyHtml } = require('../src/features/help-view');

const md = [
  '<!-- a comment that must not show -->',
  '# Guide title',
  'Intro text before any section.',
  '## First section',
  '### A question?',
  'Plain **bold** and *italic* and `code`.',
  '- one',
  '- two',
  '1. step one',
  '2. step two',
  '## Second <b>section</b>',
  'Mentions the <script>alert(1)</script> tag.',
].join('\n');

test('the guide splits into sections at each ##, with the title, ignoring comments and the intro', () => {
  const { title, sections } = helpSections(md);
  assert.equal(title, 'Guide title');
  assert.deepEqual(sections.map((s) => s.title), ['First section', 'Second <b>section</b>']);
  assert.ok(sections.every((s) => /^[a-z0-9-]+$/.test(s.id)), 'ids are safe for anchors');
  assert.equal(new Set(sections.map((s) => s.id)).size, sections.length, 'ids are unique');
  assert.doesNotMatch(JSON.stringify(sections), /a comment that must not show|Intro text/);
});

test('sections turn into headings, paragraphs, bullet and numbered lists, bold, italic and code', () => {
  const html = helpBodyHtml(helpSections(md).sections);
  assert.match(html, /<h3>A question\?<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>step one<\/li><li>step two<\/li><\/ol>/);
});

test('everything is escaped: no markup from the guide text reaches the page', () => {
  const sections = helpSections(md).sections;
  const html = helpBodyHtml(sections) + helpTocHtml(sections, sections[0].id);
  assert.doesNotMatch(html, /<script>|<b>section|<\/b>/);
  assert.match(html, /&lt;script&gt;/);
});

test('search keeps the sections that contain every word, ignoring case; no words keeps all', () => {
  const { sections } = helpSections(md);
  assert.equal(helpFilter(sections, '').length, 2);
  assert.deepEqual(helpFilter(sections, 'ITALIC step').map((s) => s.title), ['First section']);
  assert.deepEqual(helpFilter(sections, 'alert').map((s) => s.title), ['Second <b>section</b>']);
  assert.deepEqual(helpFilter(sections, 'nothing like this'), []);
});

test('search matches the start of a word, so "pin" finds pinned topics but not "typing"', () => {
  const sections = [
    { id: 'a', title: 'A', html: '', text: 'A. While typing you see a preview.' },
    { id: 'b', title: 'B', html: '', text: 'B. A pinned topic stays on top.' },
  ];
  assert.deepEqual(helpFilter(sections, 'pin').map((s) => s.id), ['b']);
  assert.deepEqual(helpFilter(sections, 'TYP').map((s) => s.id), ['a'], 'a prefix still works');
  assert.deepEqual(helpFilter(sections, 'pinned top').map((s) => s.id), ['b']);
  assert.deepEqual(helpFilter(sections, '(pin').length, 0, 'special characters are not treated as patterns');
});

test('the table of contents marks the open section', () => {
  const { sections } = helpSections(md);
  const toc = helpTocHtml(sections, sections[1].id);
  assert.match(toc, new RegExp(`data-help-section="${sections[1].id}"[^>]*aria-current="true"`));
  assert.doesNotMatch(toc, new RegExp(`data-help-section="${sections[0].id}"[^>]*aria-current`));
});

test('the real guide is well formed: a title, several sections, each with something in it', () => {
  const real = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'USER_GUIDE.md'), 'utf8');
  const { title, sections } = helpSections(real);
  assert.match(title, /User guide/);
  assert.ok(sections.length >= 5, `only ${sections.length} sections`);
  for (const section of sections) assert.ok(section.text.length > 60, `${section.title} is nearly empty`);
});

test('the copy the app loads is in step with docs/USER_GUIDE.md', () => {
  const { generate } = require('../scripts/sync-help');
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'help-guide.js'), 'utf8');
  assert.equal(onDisk, generate(), 'run `npm run help` in frontend/');
});
