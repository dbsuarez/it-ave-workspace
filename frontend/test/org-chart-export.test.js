const test = require('node:test');
const assert = require('node:assert/strict');
const { orgChartLayout, orgChartSvg, orgChartFileName } = require('../src/features/org-chart-export');

const person = (id, extra = {}) => ({ id, username: `user${id}`, ...extra });
const leaf = (id, extra) => ({ person: person(id, extra), children: [] });
const tree = (id, children, extra) => ({ person: person(id, extra), children });
const OPTS = { cardWidth: 200, cardHeight: 80, gapX: 20, gapY: 40, rootGap: 60, padding: 10 };
const byId = (layout) => new Map(layout.nodes.map((n) => [n.id, n]));

test('a single person is one card inside the padding, and the picture is just big enough', () => {
  const layout = orgChartLayout([leaf(1)], OPTS);
  assert.equal(layout.nodes.length, 1);
  assert.deepEqual([layout.nodes[0].x, layout.nodes[0].y, layout.nodes[0].width, layout.nodes[0].height], [10, 10, 200, 80]);
  assert.deepEqual([layout.width, layout.height], [220, 100]);
  assert.deepEqual(layout.links, []);
});

test('a manager sits centred above the reports, which share a row and keep the gap between them', () => {
  const layout = orgChartLayout([tree(1, [leaf(2), leaf(3)])], OPTS);
  const n = byId(layout);
  assert.equal(n.get(2).y, n.get(3).y);
  assert.equal(n.get(3).x - (n.get(2).x + 200), 20, 'the gap between siblings');
  assert.equal(n.get(1).x + 100, (n.get(2).x + n.get(3).x + 200) / 2, 'centred over the two');
  assert.equal(n.get(2).y - (n.get(1).y + 80), 40, 'the gap between levels');
  assert.equal(layout.width, 10 + 200 + 20 + 200 + 10);
  assert.equal(layout.height, 10 + 80 + 40 + 80 + 10);
});

test('a wide team pushes its neighbours apart so no two cards in a row overlap', () => {
  const big = tree(2, [leaf(4), leaf(5), leaf(6)]);
  const layout = orgChartLayout([tree(1, [big, tree(3, [leaf(7)])])], OPTS);
  const rows = new Map();
  for (const node of layout.nodes) rows.set(node.y, [...(rows.get(node.y) || []), node]);
  for (const row of rows.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].x >= sorted[i - 1].x + 200, `row at ${sorted[0].y} overlaps`);
  }
  assert.ok(layout.nodes.every((node) => node.x >= 10 && node.x + 200 <= layout.width - 10), 'everything is inside the picture');
});

test('there is one link for each visible reporting line, from manager to report', () => {
  const layout = orgChartLayout([tree(1, [tree(2, [leaf(3)]), leaf(4)])], OPTS);
  assert.deepEqual(layout.links.map((l) => `${l.from}>${l.to}`).sort(), ['1>2', '1>4', '2>3']);
});

test('a collapsed team is hidden and counted, links and all', () => {
  const layout = orgChartLayout([tree(1, [tree(2, [leaf(3), leaf(4)]), leaf(5)])], { ...OPTS, collapsed: new Set([2]) });
  assert.deepEqual(layout.nodes.map((n) => n.id).sort(), [1, 2, 5]);
  assert.equal(byId(layout).get(2).hidden, 2);
  assert.equal(byId(layout).get(1).hidden, 0);
  assert.deepEqual(layout.links.map((l) => `${l.from}>${l.to}`).sort(), ['1>2', '1>5']);
});

test('several top-level people are stacked one under another, centred, without touching', () => {
  const layout = orgChartLayout([tree(1, [leaf(2), leaf(3)]), leaf(4)], OPTS);
  const n = byId(layout);
  assert.ok(n.get(4).y >= n.get(2).y + 80 + 60, 'the second top person starts below the first chart with the root gap');
  assert.equal(n.get(4).x + 100, layout.width / 2, 'centred in the picture');
});

test('nobody to show gives a small empty picture instead of an error', () => {
  const layout = orgChartLayout([], OPTS);
  assert.deepEqual(layout.nodes, []);
  assert.ok(layout.width > 0 && layout.height > 0);
});

test('a person who matched a search is marked', () => {
  const layout = orgChartLayout([{ person: person(1), children: [], matched: true }, leaf(2)], OPTS);
  assert.equal(byId(layout).get(1).matched, true);
  assert.equal(byId(layout).get(2).matched, false);
});

const plain = (layout, extra = {}) => orgChartSvg(layout, { nameOf: (p) => p.username, ...extra });

test('the SVG is a complete standalone image of the same size, with a white background and a card for each person', () => {
  const layout = orgChartLayout([tree(1, [leaf(2), leaf(3)])], OPTS);
  const svg = plain(layout);
  assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(svg, /<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, new RegExp(`viewBox="0 0 ${layout.width} ${layout.height}"`));
  assert.match(svg, new RegExp(`width="${layout.width}" height="${layout.height}"`));
  assert.match(svg, /<rect [^>]*fill="#ffffff"/);
  assert.equal((svg.match(/data-org-card="/g) || []).length, 3);
  assert.equal((svg.match(/data-org-link="/g) || []).length, 2);
  assert.doesNotMatch(svg, /<script|foreignObject|onload=/i);
});

test('names, titles and departments are shown, escaped, and long ones are cut with an ellipsis', () => {
  const layout = orgChartLayout([leaf(1, { jobTitle: 'Boss <A> & B', department: 'MIS', username: 'x'.repeat(80) })], OPTS);
  const svg = plain(layout);
  assert.match(svg, /Boss &lt;A&gt; &amp; B/);
  assert.doesNotMatch(svg, /<A>/);
  assert.match(svg, />MIS</);
  assert.match(svg, /x{10,}…/);
  assert.doesNotMatch(svg, /x{40}/);
});

test('a person with no photo gets their initial on their colour, and one with a photo gets it clipped to the same rounded square as on screen', () => {
  const layout = orgChartLayout([leaf(1), leaf(2)], OPTS);
  const svg = plain(layout, { avatarFor: (p) => (p.id === 1 ? { color: '#112233', initial: 'A' } : { color: '#445566', initial: 'B', photo: 'data:image/png;base64,AAAA' }) });
  assert.match(svg, /<rect[^>]*rx="11"[^>]*fill="#112233"/);
  assert.match(svg, />A<\/text>/);
  assert.match(svg, /<clipPath id="clip-2"/);
  assert.match(svg, /<image [^>]*href="data:image\/png;base64,AAAA"[^>]*clip-path="url\(#clip-2\)"/);
});

test('a hidden team shows as a count on the card', () => {
  const layout = orgChartLayout([tree(1, [leaf(2), leaf(3)])], { ...OPTS, collapsed: new Set([1]) });
  assert.match(plain(layout), />\+2 hidden</);
});

test('also-reports-to lines are dashed and drawn only when both people are in the picture', () => {
  const layout = orgChartLayout([tree(1, [leaf(2), leaf(3)])], OPTS);
  const svg = plain(layout, { secondary: [{ person: 3, manager: 2 }, { person: 3, manager: 99 }] });
  assert.equal((svg.match(/data-org-dotted="/g) || []).length, 1);
  assert.match(svg, /stroke-dasharray="6 5"/);
  assert.doesNotMatch(plain(layout), /data-org-dotted/);
});

test('a search match has the purple outline, and a caption can be added', () => {
  const layout = orgChartLayout([{ person: person(1), children: [], matched: true }], OPTS);
  assert.match(plain(layout), /data-org-card="1"[^>]*stroke="#7c3aed"|stroke="#7c3aed"[^>]*data-org-card="1"/);
  const withCaption = plain(layout, { caption: 'IT Avenue Workspace <org chart>' });
  assert.match(withCaption, /IT Avenue Workspace &lt;org chart&gt;/);
});

test('the file name has the date and the format', () => {
  assert.equal(orgChartFileName(new Date(2026, 10, 18), 'svg'), 'org-chart-2026-11-18.svg');
  assert.equal(orgChartFileName(new Date(2026, 0, 5), 'png'), 'org-chart-2026-01-05.png');
});
