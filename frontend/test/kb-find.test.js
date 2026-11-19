// Knowledge Base article tools: find in the article (the text pieces to highlight) and the outline for the floating table of contents. Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const { kbFindSegments, kbOutline } = require('../src/features/kb-find');

test('find splits a text into plain and matching pieces, ignoring case, keeping the original letters', () => {
  assert.deepEqual(kbFindSegments('File a Leave, then leave.', 'leave'), [
    { text: 'File a ', match: false }, { text: 'Leave', match: true }, { text: ', then ', match: false }, { text: 'leave', match: true }, { text: '.', match: false },
  ]);
  assert.deepEqual(kbFindSegments('nothing here', 'zzz'), [{ text: 'nothing here', match: false }]);
  assert.deepEqual(kbFindSegments('leave', 'leave'), [{ text: 'leave', match: true }]);
});

test('what is typed is searched as plain text, not as a pattern, and an empty search finds nothing', () => {
  assert.deepEqual(kbFindSegments('a.b (c) [d] 100%', '(c)'), [{ text: 'a.b ', match: false }, { text: '(c)', match: true }, { text: ' [d] 100%', match: false }]);
  assert.equal(kbFindSegments('a.b', '.').filter((s) => s.match).length, 1, 'a dot is just a dot');
  assert.deepEqual(kbFindSegments('text', ''), [{ text: 'text', match: false }]);
  assert.deepEqual(kbFindSegments('text', '   '), [{ text: 'text', match: false }]);
  assert.deepEqual(kbFindSegments('', 'x'), []);
});

test('the outline lists the headings in order with their level, without the # marks, for the contents list', () => {
  const sections = [
    { id: 's1', type: 'heading', text: '# Filing a leave' },
    { id: 's2', type: 'paragraph', text: 'Open People.' },
    { id: 's3', type: 'heading', text: '## Before you start ##' },
    { id: 's4', type: 'heading', text: '### Documents' },
    { id: 's5', type: 'list', text: '- one' },
    { id: 's6', type: 'heading', text: '###### Deep one' },
  ];
  assert.deepEqual(kbOutline(sections), [
    { id: 's1', level: 1, title: 'Filing a leave' },
    { id: 's3', level: 2, title: 'Before you start' },
    { id: 's4', level: 3, title: 'Documents' },
    { id: 's6', level: 4, title: 'Deep one' },
  ]);
  assert.deepEqual(kbOutline([]), []);
  assert.deepEqual(kbOutline(undefined), []);
  assert.deepEqual(kbOutline([{ id: 'x', type: 'heading', text: '#' }]), [], 'an empty heading is left out');
});
