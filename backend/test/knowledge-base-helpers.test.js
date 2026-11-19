// Knowledge Base: the rules for what is sent, and the search helpers. Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../src/knowledgeBase');

test('a category title is 1 to 80 characters and an article title 1 to 160, trimmed', () => {
  assert.equal(kb.cleanCategoryTitle('  Leave  '), 'Leave');
  assert.equal(kb.cleanArticleTitle(' How do I file a leave? '), 'How do I file a leave?');
  for (const bad of ['', '   ', null, undefined, 5, 'x'.repeat(81)]) assert.throws(() => kb.cleanCategoryTitle(bad), /category/i, String(bad));
  for (const bad of ['', '   ', null, 'x'.repeat(161)]) assert.throws(() => kb.cleanArticleTitle(bad), /title/i, String(bad));
  assert.equal(kb.cleanArticleTitle('x'.repeat(160)).length, 160);
});

test('an article body is text of at most 100,000 characters, and may be empty while it is being written', () => {
  assert.equal(kb.cleanBody('# Hello\n\nText'), '# Hello\n\nText');
  assert.equal(kb.cleanBody(''), '');
  assert.equal(kb.cleanBody(undefined), '');
  assert.throws(() => kb.cleanBody('x'.repeat(100001)), /100,000/);
  assert.throws(() => kb.cleanBody(42), /text/i);
});

test('a search needs two characters and treats % and _ as themselves', () => {
  assert.equal(kb.searchPattern('  leave '), '%leave%');
  assert.equal(kb.searchPattern('100%'), '%100\\%%');
  assert.equal(kb.searchPattern('a_b'), '%a\\_b%');
  assert.equal(kb.searchPattern('c:\\x'), '%c:\\\\x%');
  assert.throws(() => kb.searchPattern('a'), /at least 2/);
  assert.throws(() => kb.searchPattern(' '), /at least 2/);
  assert.throws(() => kb.searchPattern(undefined), /at least 2/);
  assert.throws(() => kb.searchPattern('x'.repeat(101)), /at most 100/);
});

test('a snippet shows the text around the first match, without the Markdown marks', () => {
  const body = `# Filing leave\n\nFirst open **People**, then press *Leave* and choose ${'a '.repeat(80)}Request leave at the end.`;
  const snippet = kb.snippetFor(body, 'request leave', 60);
  assert.match(snippet, /Request leave/i);
  assert.ok(snippet.length <= 70, snippet.length);
  assert.equal(/[*#]/.test(snippet), false);
  assert.match(snippet, /^…/, 'it starts mid-text, so it says so');
  assert.equal(kb.snippetFor('# Title\n\nShort answer here.', 'nomatch', 60), 'Title Short answer here.', 'no match in the text: the start of it');
  assert.equal(kb.snippetFor('', 'x', 60), '');
});

test('a snippet from a table reads as words, not as pipes and dashes', () => {
  const table = ['Open People.', '', '| Type | Days |', '|---|---|', '| Vacation | 15 |'].join(String.fromCharCode(10));
  const snippet = kb.snippetFor(table, 'vacation', 80);
  assert.equal(/[|]|---/.test(snippet), false, snippet);
  assert.match(snippet, /Type Days Vacation 15/);
});

test('a new order must list every id once, no more and no less', () => {
  assert.deepEqual(kb.cleanOrderIds([3, 1, 2], [1, 2, 3]), [3, 1, 2]);
  for (const bad of [[1, 2], [1, 2, 3, 4], [1, 1, 2], 'x', [1, 2, 'a'], null]) assert.throws(() => kb.cleanOrderIds(bad, [1, 2, 3]), /order/i, JSON.stringify(bad));
});

test('an import is 1 to 200 articles, each with a title and a body', () => {
  const ok = kb.cleanImport([{ title: ' One ', body: 'text' }, { title: 'Two', body: '' }]);
  assert.deepEqual(ok, [{ title: 'One', body: 'text' }, { title: 'Two', body: '' }]);
  assert.throws(() => kb.cleanImport([]), /1 to 200/);
  assert.throws(() => kb.cleanImport(Array.from({ length: 201 }, (_, i) => ({ title: `t${i}`, body: '' }))), /1 to 200/);
  assert.throws(() => kb.cleanImport([{ title: '', body: 'x' }]), /title/i);
  assert.throws(() => kb.cleanImport('x'), /1 to 200/);
});

test('the screens an article can help with are a fixed list, and a chosen list is checked and de-duplicated', () => {
  assert.ok(kb.KB_SCREENS.some((s) => s.key === 'leave' && s.label === 'Leave'));
  assert.ok(kb.KB_SCREENS.some((s) => s.key === 'attendance'));
  assert.deepEqual(kb.cleanScreens(['leave', 'attendance', 'leave']), ['leave', 'attendance']);
  assert.deepEqual(kb.cleanScreens([]), []);
  assert.deepEqual(kb.cleanScreens(undefined), []);
  assert.throws(() => kb.cleanScreens(['nowhere']), /screen/i);
  assert.throws(() => kb.cleanScreens('leave'), /screen/i);
  assert.equal(kb.cleanScreenKey('leave'), 'leave');
  assert.throws(() => kb.cleanScreenKey('x'), /screen/i);
});
