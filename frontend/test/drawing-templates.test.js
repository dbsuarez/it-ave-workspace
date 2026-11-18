const test = require('node:test');
const assert = require('node:assert/strict');
const { DRAWING_MERMAID_TEMPLATES, mermaidTemplatesHtml, applyMermaidTemplate } = require('../src/features/drawing-templates');

test('there are templates for each diagram type the editor converts to shapes', () => {
  const kinds = new Set(DRAWING_MERMAID_TEMPLATES.map((template) => template.kind));
  assert.deepEqual([...kinds].sort(), ['Class diagram', 'Flowchart', 'Sequence diagram']);
});

test('every template has a unique id, a name, a hint and text that starts with its diagram keyword', () => {
  const ids = new Set();
  for (const template of DRAWING_MERMAID_TEMPLATES) {
    assert.ok(template.id && !ids.has(template.id), `unique id: ${template.id}`);
    ids.add(template.id);
    assert.ok(template.name && template.hint);
    const first = template.code.split('\n')[0].trim();
    const wanted = { Flowchart: /^flowchart (TD|LR)$/, 'Sequence diagram': /^sequenceDiagram$/, 'Class diagram': /^classDiagram$/ }[template.kind];
    assert.match(first, wanted, `first line of ${template.id}`);
    assert.doesNotMatch(template.code, /\t/);
  }
});

test('the gallery shows one button per template, grouped by diagram type, with every value escaped', () => {
  const html = mermaidTemplatesHtml([
    { id: 'a', kind: 'Flowchart', name: 'Steps <1>', hint: 'x "y"', code: 'flowchart TD' },
    { id: 'b', kind: 'Class diagram', name: 'Model', hint: 'z', code: 'classDiagram' },
  ]);
  assert.equal((html.match(/data-mermaid-template="/g) || []).length, 2);
  assert.match(html, /Flowchart/);
  assert.match(html, /Class diagram/);
  assert.match(html, /Steps &lt;1&gt;/);
  assert.match(html, /title="x &quot;y&quot;"/);
  assert.doesNotMatch(html, /<1>/);
});

test('choosing a template fills the box and tells the editor the text changed', () => {
  const events = [];
  const box = { value: '', dispatchEvent: (event) => events.push(event.type) };
  const used = applyMermaidTemplate(box, 'flowchart LR\n A --> B', (target, value) => { target.value = value; });
  assert.equal(box.value, 'flowchart LR\n A --> B');
  assert.deepEqual(events, ['input']);
  assert.equal(used.previous, '');
});

test('the text you had before a template can be put back', () => {
  const box = { value: 'my own diagram', dispatchEvent() {} };
  const set = (target, value) => { target.value = value; };
  const first = applyMermaidTemplate(box, 'classDiagram', set);
  assert.equal(first.previous, 'my own diagram');
  const second = applyMermaidTemplate(box, 'sequenceDiagram', set, first.previous);
  assert.equal(second.previous, 'my own diagram', 'the first thing you typed is kept across several templates');
  applyMermaidTemplate(box, second.previous, set);
  assert.equal(box.value, 'my own diagram');
});
