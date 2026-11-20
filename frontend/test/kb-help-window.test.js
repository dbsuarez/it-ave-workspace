// The floating Help window: markup and where it may be dragged. Pure: data in, HTML or numbers out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { kbHelpWindowHtml, kbHelpWindowClamp } = require('../src/features/kb-help-window');

test('the window shows the article, with a way to open it in the Knowledge Base and a way to close it', () => {
  const html = kbHelpWindowHtml({ title: 'How <do> I file?', bodyHtml: '<p>Press New.</p>', articleId: 14 });
  assert.match(html, /How &lt;do&gt; I file\?/);
  assert.doesNotMatch(html, /How <do>/);
  assert.match(html, /<p>Press New\.<\/p>/, 'the article text is already safe HTML from the reading view');
  assert.match(html, /data-kb-help-window-open="14"[^>]*title="[^"]*Knowledge Base/);
  assert.match(html, /data-kb-help-window-close[^>]*aria-label="Close/);
  assert.match(html, /data-kb-help-window-drag/, 'the header is the drag handle');
});

test('a dragged window can never be lost off the screen: its header always stays reachable', () => {
  const view = { vw: 1200, vh: 800 };
  assert.deepEqual(kbHelpWindowClamp({ left: 100, top: 100, width: 420, height: 500, ...view }), { left: 100, top: 100 });
  assert.equal(kbHelpWindowClamp({ left: -900, top: 100, width: 420, height: 500, ...view }).left, -420 + 80, 'at least 80px of it stays on the left');
  assert.equal(kbHelpWindowClamp({ left: 5000, top: 100, width: 420, height: 500, ...view }).left, 1200 - 80, 'and on the right');
  assert.equal(kbHelpWindowClamp({ left: 100, top: -50, width: 420, height: 500, ...view }).top, 0, 'the header never goes above the screen');
  assert.equal(kbHelpWindowClamp({ left: 100, top: 9999, width: 420, height: 500, ...view }).top, 800 - 40, 'and at least 40px of it stays at the bottom');
});
