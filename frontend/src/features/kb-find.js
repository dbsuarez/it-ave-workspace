// IT Avenue Workspace - Knowledge Base article tools: find in the article (matches are highlighted, with next and previous) and the outline
// for the floating "On this page" contents list. The text and outline helpers are pure (tested in frontend/test/kb-find.test.js); the
// functions below them work on the page. Loaded before knowledge-base.js, which wires them to the article screen.

const KB_FIND_MAX_MATCHES = 500;

// A text split into plain and matching pieces. The search is plain text (not a pattern), ignores case, and keeps the original letters.
function kbFindSegments(text, query) {
  const source = String(text ?? '');
  const needle = String(query ?? '').trim().toLowerCase();
  if (!source) return [];
  if (!needle) return [{ text: source, match: false }];
  const lower = source.toLowerCase();
  const pieces = [];
  let at = 0;
  for (;;) {
    const found = lower.indexOf(needle, at);
    if (found < 0) break;
    if (found > at) pieces.push({ text: source.slice(at, found), match: false });
    pieces.push({ text: source.slice(found, found + needle.length), match: true });
    at = found + needle.length;
  }
  if (at < source.length) pieces.push({ text: source.slice(at), match: false });
  return pieces;
}

// The headings of an article for the contents list: [{ id, level, title }] from the sections the server sends (type 'heading').
function kbOutline(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.filter((section) => section && section.type === 'heading').map((section) => {
    const text = String(section.text || '');
    const marks = /^\s{0,3}(#{1,6})/.exec(text);
    return {
      id: section.id,
      level: Math.min(marks ? marks[1].length : 1, 4),
      title: text.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '').trim(),
    };
  }).filter((item) => item.title);
}

// ---------------------------------------------------------------------------------------------------------------- on the page

const kbFindState = { root: null, marks: [], index: -1 };

function kbFindClear(root) {
  if (!root) return;
  root.querySelectorAll('mark.kb-find').forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
  root.normalize();
  kbFindState.root = root; kbFindState.marks = []; kbFindState.index = -1;
}

function kbFindShowCurrent(scroll) {
  kbFindState.marks.forEach((mark, i) => mark.classList.toggle('kb-find-current', i === kbFindState.index));
  const current = kbFindState.marks[kbFindState.index];
  if (current && scroll) current.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Highlights every match of `query` inside `root` and makes the first one current. Returns how many there are.
function kbFindApply(root, query) {
  kbFindClear(root);
  if (!root || !String(query || '').trim()) return 0;
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let total = 0;
  for (const node of nodes) {
    if (total >= KB_FIND_MAX_MATCHES) break;
    if (node.parentElement && node.parentElement.closest('script, style, [data-kb-no-find]')) continue;
    const pieces = kbFindSegments(node.nodeValue, query);
    if (!pieces.some((piece) => piece.match)) continue;
    const fragment = document.createDocumentFragment();
    for (const piece of pieces) {
      if (!piece.match) { fragment.appendChild(document.createTextNode(piece.text)); continue; }
      const mark = document.createElement('mark');
      mark.className = 'kb-find';
      mark.textContent = piece.text;
      fragment.appendChild(mark);
      total += 1;
    }
    node.replaceWith(fragment);
  }
  kbFindState.root = root;
  kbFindState.marks = [...root.querySelectorAll('mark.kb-find')];
  kbFindState.index = kbFindState.marks.length ? 0 : -1;
  kbFindShowCurrent(true);
  return kbFindState.marks.length;
}

// Moves to the next (direction 1) or previous (-1) match, wrapping round. Returns the position (1-based) or 0 when there are none.
function kbFindStep(direction) {
  const count = kbFindState.marks.length;
  if (!count) return 0;
  kbFindState.index = (kbFindState.index + direction + count) % count;
  kbFindShowCurrent(true);
  return kbFindState.index + 1;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { kbFindSegments, kbOutline };
}
