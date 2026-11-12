const test = require('node:test');
const assert = require('node:assert/strict');
const { renderCanvasSection, renderCanvasSections } = require('../src/features/canvas-render');

const render = (type, text, extra = {}) => renderCanvasSection({ id: '0-abc123', type, text, ...extra }, { usernames: [], me: '' });

test('user text can never become markup', () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
  for (const type of ['heading', 'paragraph', 'list', 'quote', 'table', 'checklist', 'code']) {
    const text = { heading: `# ${evil}`, list: `- ${evil}`, quote: `> ${evil}`, checklist: `- [ ] ${evil}`, table: `| ${evil} |\n| - |\n| ${evil} |`, code: `\`\`\`\n${evil}\n\`\`\`` }[type] || evil;
    const html = render(type, text);
    assert.ok(!/<img|<script/i.test(html), `${type}: ${html}`);
    assert.ok(html.includes('&lt;'), `${type} escapes angle brackets`);
  }
  assert.ok(!render('paragraph', 'x').includes('onerror'));
  // a data attribute built from a section id is escaped too
  const odd = renderCanvasSection({ id: '"><b>', type: 'divider', text: '---' }, {});
  assert.ok(!odd.includes('"><b>'));
});

test('headings map to h1 to h3 and deeper levels stay h4', () => {
  assert.ok(render('heading', '# Big').includes('<h1 class="cv-h">Big</h1>'));
  assert.ok(render('heading', '## Mid').includes('<h2'));
  assert.ok(render('heading', '### Small').includes('<h3'));
  assert.ok(render('heading', '###### Tiny ##').includes('<h4 class="cv-h">Tiny</h4>'));
});

test('paragraphs keep emphasis and line breaks', () => {
  const html = render('paragraph', 'one **two**\nthree');
  assert.ok(html.includes('one <strong>two</strong><br>three'));
});

test('font colors render from the narrow saved syntax without allowing arbitrary attributes', () => {
  const html = render('paragraph', 'Plain <span data-color="#c2410c">orange and **bold**</span>.');
  assert.ok(html.includes('<span data-color="#c2410c" style="color:#c2410c">orange and <strong>bold</strong></span>'));
  const unsafe = render('paragraph', '<span data-color="#c2410c" onclick="bad()">no</span>');
  assert.ok(!unsafe.includes('onclick="bad()"'));
  assert.ok(unsafe.includes('&lt;span'));
  assert.ok(render('list', '- <span data-color="#2563eb">blue</span>').includes('style="color:#2563eb"'));
  assert.ok(render('quote', '> <span data-color="#15803d">green</span>').includes('style="color:#15803d"'));
});

test('checklists render interactive boxes that name their section and item', () => {
  const html = render('checklist', '- [ ] write\n- [x] review\n  nested note');
  assert.ok(html.includes('data-cv-toggle="0-abc123:0"'));
  assert.ok(html.includes('data-cv-toggle="0-abc123:1" checked'));
  assert.ok(html.includes('cv-check done'));
  assert.ok(html.includes('cv-check-extra'), 'a non-checkbox line inside the block is kept as text');
  const locked = renderCanvasSection({ id: '1-x', type: 'checklist', text: '- [ ] a' }, { canEdit: false });
  assert.ok(locked.includes('disabled'), 'viewers cannot toggle');
});

test('tables render a header, body and column alignment', () => {
  const html = render('table', '| Name | Qty | Note |\n| :-- | --: | :-: |\n| apples | 3 | **good** |\n| pears | 4 |');
  assert.ok(html.includes('<th style="text-align:left">Name</th>'));
  assert.ok(html.includes('<th style="text-align:right">Qty</th>'));
  assert.ok(html.includes('<th style="text-align:center">Note</th>'));
  assert.ok(html.includes('<td style="text-align:center"><strong>good</strong></td>'));
  assert.ok(html.includes('<td style="text-align:center"></td>'), 'a short row is padded');
  assert.equal((html.match(/<tr>/g) || []).length, 3);
});

test('callouts show their kind, title and body', () => {
  const html = render('quote', '> [!warning] Heads up\n> Back up first\n> then deploy');
  assert.ok(html.includes('cv-callout-warning'));
  assert.ok(html.includes('<strong class="cv-callout-title">Heads up</strong>'));
  assert.ok(html.includes('Back up first<br>then deploy'));
  assert.ok(render('quote', '> [!tip]').includes('>Tip</strong>'), 'a default title when none is given');
  assert.ok(render('quote', '> just a quote').includes('message-quote'), 'an ordinary quote is not a callout');
});

test('code keeps its text and language, dividers and lists render', () => {
  const html = render('code', '```js\nconst a = "<b>";\n```');
  assert.ok(html.includes('cv-code-lang">js<'));
  assert.ok(html.includes('const a = &quot;&lt;b&gt;&quot;;'));
  assert.ok(render('divider', '---').includes('<hr class="cv-hr">'));
  assert.ok(render('list', '- a\n- b').includes('<ul class="message-list"><li>a</li><li>b</li></ul>'));
});

test('an empty canvas explains itself, and sections keep their id and type as hooks', () => {
  assert.ok(renderCanvasSections([], {}).includes('This canvas is empty'));
  const html = renderCanvasSections([{ id: '0-aa', type: 'heading', text: '# T' }, { id: '1-bb', type: 'paragraph', text: 'p' }], {});
  assert.ok(html.includes('data-section-id="0-aa"') && html.includes('cv-heading'));
  assert.ok(html.includes('data-section-id="1-bb"') && html.includes('cv-paragraph'));
});

test('a picture line becomes a figure with no URL in the page', () => {
  const html = render('paragraph', '![A <b>cat</b>](file:12)');
  assert.match(html, /<figure class="cv-image"><img data-cv-file="12" alt="A &lt;b&gt;cat&lt;\/b&gt;">/);
  assert.doesNotMatch(html, /src=/, 'the image is loaded by the app with the sign-in');
  const mixed = render('paragraph', 'before\n![x](file:3)\nafter');
  assert.match(mixed, /<p>before<\/p><figure[^>]*>.*<\/figure><p>after<\/p>/);
  assert.doesNotMatch(render('paragraph', '![x](https://evil.test/a.png)'), /<img/, 'only canvas files, never outside links');
  assert.doesNotMatch(render('paragraph', '![x](file:1) trailing'), /<figure/, 'it must be a line of its own');
});
