const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.DOMParser = dom.window.DOMParser;
const { exportCardsInDoc, exportCardsInHtml, soloMentionNames, soloMentionName } = require('../src/features/export-prepare');

const people = {
  ann: { username: 'ann', email: 'ann@itavenue.ph', jobTitle: 'IT Manager', status: 'online', statusText: 'Busy', statusEmoji: '*', avatarColor: '#123456', accountType: 'member' },
  gus: { username: 'gus', email: 'gus@x.test', accountType: 'guest', avatarColor: '#ABCDEF' },
};
const lookup = (name) => people[String(name).toLowerCase()] || null;
const mention = (username) => ({ type: 'mention', attrs: { username } });
const solo = (username) => ({ type: 'paragraph', content: [mention(username)] });
const text = (value) => ({ type: 'text', text: value });

test('only a paragraph holding one mention is a solo mention', () => {
  assert.equal(soloMentionName(solo('ann')), 'ann');
  assert.equal(soloMentionName({ type: 'paragraph', content: [text('  '), mention('ann'), text(' ')] }), 'ann', 'spaces around it are fine');
  assert.equal(soloMentionName({ type: 'paragraph', content: [text('hi '), mention('ann')] }), null);
  assert.equal(soloMentionName({ type: 'paragraph', content: [mention('ann'), mention('bob')] }), null);
  assert.equal(soloMentionName({ type: 'heading', content: [mention('ann')] }), null);
  assert.equal(soloMentionName({ type: 'paragraph' }), null);
});

test('solo mentions of known people become profile cards, wherever they are in the document', () => {
  const doc = {
    type: 'doc',
    content: [
      solo('ann'),
      { type: 'paragraph', content: [text('ping '), mention('ann')] },
      solo('nobody'),
      { type: 'callout', attrs: { type: 'info' }, content: [solo('gus')] },
    ],
  };
  assert.deepEqual(Array.from(soloMentionNames(doc)).sort(), ['ann', 'gus', 'nobody']);
  const out = exportCardsInDoc(doc, lookup, { ann: { base64: 'AAAA', width: 2, height: 2 } });
  assert.equal(out.content[0].type, 'profileCard');
  assert.equal(out.content[0].attrs.username, 'ann');
  assert.equal(out.content[0].attrs.jobTitle, 'IT Manager');
  assert.equal(out.content[0].attrs.statusText, '* Busy');
  assert.deepEqual(out.content[0].attrs.photo, { base64: 'AAAA', width: 2, height: 2 });
  assert.equal(out.content[1].type, 'paragraph', 'an inline mention stays text');
  assert.equal(out.content[2].type, 'paragraph', 'an unknown person stays text');
  assert.equal(out.content[3].content[0].type, 'profileCard');
  assert.equal(out.content[3].content[0].attrs.role, 'Guest');
  assert.equal(doc.content[0].type, 'paragraph', 'the original is not changed');
});

test('in the PDF page a solo mention becomes a card', () => {
  const html = '<p>before</p><p><span data-mention="ann">@ann</span></p><p>ping <span data-mention="ann">@ann</span></p><p><span data-mention="zed">@zed</span></p>';
  const out = exportCardsInHtml(html, lookup, { ann: 'data:image/png;base64,AAAA' });
  const page = new JSDOM(`<body>${out}</body>`).window.document;
  const cards = page.querySelectorAll('.pcard');
  assert.equal(cards.length, 1);
  assert.match(cards[0].textContent, /ann/);
  assert.match(cards[0].textContent, /IT Manager/);
  assert.match(cards[0].textContent, /ann@itavenue\.ph/);
  assert.match(cards[0].textContent, /Busy/);
  assert.ok(cards[0].querySelector('.pcard-dot.online'));
  assert.match(cards[0].querySelector('.pcard-avatar').getAttribute('style'), /data:image\/png;base64,AAAA/, 'the photo');
  assert.equal(page.querySelectorAll('span[data-mention]').length, 2, 'the inline and the unknown mention stay as they were');
  const plain = new JSDOM(`<body>${exportCardsInHtml(html, lookup)}</body>`).window.document.querySelector('.pcard-avatar');
  assert.equal(plain.textContent, 'A', 'the initial when there is no photo');
});

test('a person’s details cannot inject markup into the PDF page', () => {
  const evil = { username: 'x', email: '<img src=x onerror=alert(1)>', jobTitle: '<script>alert(1)</script>', avatarColor: 'red;background:url(http://evil)' };
  const out = exportCardsInHtml('<p><span data-mention="x">@x</span></p>', () => evil);
  assert.ok(!/<script|<img/i.test(out), 'details are text, not markup');
  assert.ok(!/url\(http/.test(out), 'a bad color is ignored');
});
