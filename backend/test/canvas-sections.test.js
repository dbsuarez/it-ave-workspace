const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSections, describeSections, applyOperation } = require('../src/canvasSections');

const DOC = [
  '# Plan',
  '',
  'Intro line one',
  'still the same paragraph',
  '',
  '- [ ] write spec',
  '- [x] review',
  '- [ ] ship',
  '',
  '```js',
  '# not a heading',
  '',
  'const a = 1;',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '> quoted',
  '> more',
  '',
  '---',
  '',
  '1. one',
  '2. two',
].join('\n');

test('parses the top-level blocks with their types', () => {
  const blocks = parseSections(DOC);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'checklist', 'code', 'table', 'quote', 'divider', 'list']);
  assert.equal(blocks[1].text, 'Intro line one\nstill the same paragraph');
  assert.equal(blocks[3].text.split('\n').length, 5, 'a blank line and a # inside a fence stay in the code block');
  blocks.forEach((b) => assert.equal(DOC.slice(b.start, b.end), b.text, 'offsets match the text'));
});

test('section ids are stable for the same text and change when the text changes', () => {
  const a = parseSections(DOC).map((b) => b.id);
  assert.deepEqual(parseSections(DOC).map((b) => b.id), a);
  const edited = parseSections(DOC.replace('Intro line one', 'Intro changed'));
  assert.notEqual(edited[1].id, a[1]);
  assert.equal(edited[0].id, a[0]);
});

test('lookup filters by type and by text, and lists checklist items', () => {
  assert.equal(describeSections(DOC, { type: 'heading' }).length, 1);
  const found = describeSections(DOC, { contains: 'SHIP' });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].items, [
    { index: 0, checked: false, text: 'write spec' },
    { index: 1, checked: true, text: 'review' },
    { index: 2, checked: false, text: 'ship' },
  ]);
  assert.equal(describeSections(DOC, { contains: 'nothing like this' }).length, 0);
});

test('insert_after, insert_before, start and end touch only what they should', () => {
  const heading = parseSections(DOC)[0];
  const after = applyOperation(DOC, { op: 'insert_after', sectionId: heading.id, markdown: '## New' }).content;
  assert.ok(after.startsWith('# Plan\n\n## New\n\nIntro line one'));
  assert.equal(after.slice(after.indexOf('Intro line one')), DOC.slice(DOC.indexOf('Intro line one')), 'the rest is byte-identical');
  const before = applyOperation(DOC, { op: 'insert_before', sectionId: heading.id, markdown: 'Top note' }).content;
  assert.ok(before.startsWith('Top note\n\n# Plan'));
  assert.ok(applyOperation(DOC, { op: 'insert_at_start', markdown: 'First' }).content.startsWith('First\n\n# Plan'));
  assert.ok(applyOperation(DOC, { op: 'insert_at_end', markdown: 'Last' }).content.endsWith('2. two\n\nLast'));
  assert.equal(applyOperation('', { op: 'insert_at_end', markdown: 'Only' }).content, 'Only');
});

test('replace swaps one section, or the whole document when no section is given', () => {
  const para = parseSections(DOC)[1];
  const replaced = applyOperation(DOC, { op: 'replace', sectionId: para.id, markdown: 'Rewritten' }).content;
  assert.ok(replaced.includes('# Plan\n\nRewritten\n\n- [ ] write spec'));
  assert.equal(applyOperation(DOC, { op: 'replace', markdown: 'Everything new' }).content, 'Everything new');
});

test('delete removes a section and its spacing, including the first and last', () => {
  const blocks = parseSections(DOC);
  const without = applyOperation(DOC, { op: 'delete', sectionId: blocks[1].id }).content;
  assert.ok(without.startsWith('# Plan\n\n- [ ] write spec'));
  const noLast = applyOperation(DOC, { op: 'delete', sectionId: blocks[7].id }).content;
  assert.ok(noLast.endsWith('---'));
  assert.equal(applyOperation('# Only', { op: 'delete', sectionId: parseSections('# Only')[0].id }).content, '');
});

test('toggle flips one checklist item, or sets it explicitly', () => {
  const list = parseSections(DOC)[2];
  const flipped = applyOperation(DOC, { op: 'toggle', sectionId: list.id, item: 0 }).content;
  assert.ok(flipped.includes('- [x] write spec\n- [x] review\n- [ ] ship'));
  const unchecked = applyOperation(DOC, { op: 'toggle', sectionId: list.id, item: 1 }).content;
  assert.ok(unchecked.includes('- [ ] review'));
  const stays = applyOperation(DOC, { op: 'toggle', sectionId: list.id, item: 1, checked: true }).content;
  assert.equal(stays, DOC, 'setting the state it already has changes nothing');
  assert.throws(() => applyOperation(DOC, { op: 'toggle', sectionId: list.id, item: 9 }), /does not exist/);
  assert.throws(() => applyOperation(DOC, { op: 'toggle', sectionId: parseSections(DOC)[0].id, item: 0 }), /needs a checklist/);
});

test('rename only returns a title', () => {
  assert.deepEqual(applyOperation(DOC, { op: 'rename', title: '  New name ' }), { content: null, title: 'New name' });
  assert.throws(() => applyOperation(DOC, { op: 'rename', title: '' }), /between 1 and 160/);
});

test('bad input is refused with a status code, never half applied', () => {
  const fail = (op, status, pattern) => assert.throws(() => applyOperation(DOC, op), (err) => err.status === status && pattern.test(err.message));
  fail({ op: 'explode' }, 400, /must be one of/);
  fail(null, 400, /must be one of/);
  fail({ op: 'delete', sectionId: '9-abcdef' }, 404, /not found/);
  fail({ op: 'delete' }, 400, /sectionId is required/);
  fail({ op: 'insert_at_end', markdown: '   ' }, 400, /non-empty/);
  fail({ op: 'insert_at_end', markdown: 'x'.repeat(100001) }, 400, /100,000/);
});

test('a stale section id is not found once the text moved on', () => {
  const para = parseSections(DOC)[1];
  const moved = DOC.replace('Intro line one', 'Intro changed');
  assert.throws(() => applyOperation(moved, { op: 'delete', sectionId: para.id }), (err) => err.status === 404);
});

test('Windows line endings are kept intact', () => {
  const crlf = '# Title\r\n\r\n- [ ] a\r\n- [ ] b\r\n\r\ntext';
  const list = parseSections(crlf)[1];
  assert.equal(list.type, 'checklist');
  const out = applyOperation(crlf, { op: 'toggle', sectionId: list.id, item: 1 }).content;
  assert.equal(out, '# Title\r\n\r\n- [ ] a\r\n- [x] b\r\n\r\ntext');
});
