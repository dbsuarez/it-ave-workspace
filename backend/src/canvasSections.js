// Canvas content is Markdown in one text column. A "section" is a top-level block of it
// (heading, paragraph, list, checklist, table, code fence, quote or divider). Blocks are found
// with their exact character offsets, so an edit splices only the block it touches and every other
// byte of the document stays as it was.
//
// Section IDs are "<index>-<hash>" (position plus a short hash of the block's text). They are only
// meaningful for the revision they were returned with: the edit endpoint requires that revision, so
// an ID can never be applied to a document that has moved on.
const crypto = require('crypto');

const MAX_CONTENT_LENGTH = 100000;
const MAX_SECTIONS = 2000;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const DIVIDER = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
const CHECK_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s.*|)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function hashOf(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 6);
}

function splitLines(content) {
  const lines = [];
  let position = 0;
  while (position <= content.length) {
    const newline = content.indexOf('\n', position);
    const end = newline === -1 ? content.length : newline;
    lines.push({ text: content.slice(position, end).replace(/\r$/, ''), start: position, end });
    if (newline === -1) break;
    position = newline + 1;
  }
  return lines;
}

const isBlank = (line) => line.text.trim() === '';

function startsOtherBlock(lines, index) {
  const text = lines[index].text;
  return FENCE.test(text) || HEADING.test(text) || DIVIDER.test(text) || QUOTE.test(text) || LIST_ITEM.test(text);
}

function isTableStart(lines, index) {
  const next = lines[index + 1];
  return !!next && lines[index].text.includes('|') && TABLE_SEPARATOR.test(next.text) && next.text.includes('-');
}

// Returns [{ index, id, type, start, end, text }] where content.slice(start, end) === text.
function parseSections(content) {
  const source = typeof content === 'string' ? content : '';
  const lines = splitLines(source);
  const blocks = [];
  let i = 0;

  const push = (type, firstLine, lastLine) => {
    const start = lines[firstLine].start;
    const end = lines[lastLine].end;
    const text = source.slice(start, end).replace(/\r$/, '');
    // end excludes a trailing \r so splices never swallow half of a CRLF line ending
    blocks.push({ type, start, end: start + text.length, text });
  };

  while (i < lines.length) {
    if (isBlank(lines[i])) { i += 1; continue; }
    if (blocks.length >= MAX_SECTIONS) throw httpError(400, 'This canvas has too many sections to edit by section');
    const first = i;
    const text = lines[i].text;

    const fence = FENCE.exec(text);
    if (fence) {
      const marker = fence[1][0];
      const minimum = fence[1].length;
      let j = i + 1;
      while (j < lines.length) {
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[j].text);
        if (close && close[1][0] === marker && close[1].length >= minimum) break;
        j += 1;
      }
      const last = Math.min(j, lines.length - 1);
      push('code', first, last);
      i = last + 1;
    } else if (HEADING.test(text)) {
      push('heading', first, i);
      i += 1;
    } else if (DIVIDER.test(text)) {
      push('divider', first, i);
      i += 1;
    } else if (QUOTE.test(text)) {
      let j = i;
      while (j + 1 < lines.length && !isBlank(lines[j + 1]) && QUOTE.test(lines[j + 1].text)) j += 1;
      push('quote', first, j);
      i = j + 1;
    } else if (isTableStart(lines, i)) {
      let j = i + 1;
      while (j + 1 < lines.length && !isBlank(lines[j + 1]) && lines[j + 1].text.includes('|')) j += 1;
      push('table', first, j);
      i = j + 1;
    } else if (LIST_ITEM.test(text)) {
      let j = i;
      while (j + 1 < lines.length && !isBlank(lines[j + 1])
        && (LIST_ITEM.test(lines[j + 1].text) || /^\s+\S/.test(lines[j + 1].text))) j += 1;
      const isChecklist = CHECK_ITEM.test(text);
      push(isChecklist ? 'checklist' : 'list', first, j);
      i = j + 1;
    } else {
      let j = i;
      while (j + 1 < lines.length && !isBlank(lines[j + 1]) && !startsOtherBlock(lines, j + 1) && !isTableStart(lines, j + 1)) j += 1;
      push('paragraph', first, j);
      i = j + 1;
    }
  }

  return blocks.map((block, index) => ({ index, id: `${index}-${hashOf(block.text)}`, ...block }));
}

function checklistItems(blockText) {
  const items = [];
  blockText.split('\n').forEach((line) => {
    const match = CHECK_ITEM.exec(line.replace(/\r$/, ''));
    if (match) items.push({ index: items.length, checked: match[2] !== ' ', text: match[3].trim() });
  });
  return items;
}

function previewOf(block) {
  const flat = block.text.replace(/\s+/g, ' ').trim();
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}

// Lookup used by GET /sections: optionally filtered by type and/or a case-insensitive substring.
function describeSections(content, { type, contains, limit = 200, full = false } = {}) {
  const needle = typeof contains === 'string' && contains ? contains.toLowerCase() : null;
  return parseSections(content)
    .filter((block) => (!type || block.type === type))
    .filter((block) => (!needle || block.text.toLowerCase().includes(needle)))
    .slice(0, full ? MAX_SECTIONS : limit)
    .map((block) => {
      const out = { id: block.id, index: block.index, type: block.type, preview: previewOf(block) };
      if (block.type === 'checklist') out.items = checklistItems(block.text);
      if (full) out.text = block.text;
      return out;
    });
}

function findSection(blocks, sectionId) {
  if (typeof sectionId !== 'string' || !sectionId) throw httpError(400, 'sectionId is required for this operation');
  const block = blocks.find((candidate) => candidate.id === sectionId);
  if (!block) throw httpError(404, 'Section not found in this revision; look sections up again');
  return block;
}

function cleanMarkdown(value) {
  if (typeof value !== 'string' || value.trim() === '') throw httpError(400, 'markdown must be non-empty text');
  return value.replace(/^\n+|\s+$/g, '');
}

const OPERATIONS = ['insert_after', 'insert_before', 'insert_at_start', 'insert_at_end', 'replace', 'delete', 'toggle', 'rename'];

// Applies one operation to the document. Returns { content, title } where either may be null
// (meaning "unchanged"). Throws errors that carry an HTTP status.
function applyOperation(content, operation) {
  if (!operation || typeof operation !== 'object' || !OPERATIONS.includes(operation.op)) {
    throw httpError(400, `operation.op must be one of: ${OPERATIONS.join(', ')}`);
  }
  const source = typeof content === 'string' ? content : '';
  const blocks = parseSections(source);
  let next;

  switch (operation.op) {
    case 'rename': {
      const title = typeof operation.title === 'string' ? operation.title.trim() : '';
      if (!title || title.length > 160) throw httpError(400, 'Canvas title must be between 1 and 160 characters');
      return { content: null, title };
    }
    case 'insert_at_start': {
      const markdown = cleanMarkdown(operation.markdown);
      next = source.trim() === '' ? markdown : `${markdown}\n\n${source}`;
      break;
    }
    case 'insert_at_end': {
      const markdown = cleanMarkdown(operation.markdown);
      next = source.trim() === '' ? markdown : `${source.replace(/\s+$/, '')}\n\n${markdown}`;
      break;
    }
    case 'insert_after': {
      const block = findSection(blocks, operation.sectionId);
      const markdown = cleanMarkdown(operation.markdown);
      next = `${source.slice(0, block.end)}\n\n${markdown}${source.slice(block.end)}`;
      break;
    }
    case 'insert_before': {
      const block = findSection(blocks, operation.sectionId);
      const markdown = cleanMarkdown(operation.markdown);
      next = `${source.slice(0, block.start)}${markdown}\n\n${source.slice(block.start)}`;
      break;
    }
    case 'replace': {
      const markdown = cleanMarkdown(operation.markdown);
      if (operation.sectionId === undefined || operation.sectionId === null) {
        next = markdown;
      } else {
        const block = findSection(blocks, operation.sectionId);
        next = `${source.slice(0, block.start)}${markdown}${source.slice(block.end)}`;
      }
      break;
    }
    case 'delete': {
      const block = findSection(blocks, operation.sectionId);
      const following = blocks[block.index + 1];
      if (following) {
        next = source.slice(0, block.start) + source.slice(following.start);
      } else {
        const previous = blocks[block.index - 1];
        next = previous ? source.slice(0, previous.end) : '';
      }
      break;
    }
    case 'toggle': {
      const block = findSection(blocks, operation.sectionId);
      if (block.type !== 'checklist') throw httpError(400, 'toggle needs a checklist section');
      const wanted = Number(operation.item);
      if (!Number.isInteger(wanted) || wanted < 0) throw httpError(400, 'item must be the 0-based number of a checklist item');
      if (operation.checked !== undefined && typeof operation.checked !== 'boolean') throw httpError(400, 'checked must be true or false');
      let seen = -1;
      let found = false;
      const lines = block.text.split('\n').map((line) => {
        const carriage = line.endsWith('\r') ? '\r' : '';
        const match = CHECK_ITEM.exec(line.replace(/\r$/, ''));
        if (!match) return line;
        seen += 1;
        if (seen !== wanted) return line;
        found = true;
        const nowChecked = operation.checked === undefined ? match[2] === ' ' : operation.checked;
        return `${match[1]}[${nowChecked ? 'x' : ' '}]${match[3]}${carriage}`;
      });
      if (!found) throw httpError(404, 'That checklist item does not exist');
      next = `${source.slice(0, block.start)}${lines.join('\n')}${source.slice(block.end)}`;
      break;
    }
    default:
      throw httpError(400, 'Unsupported operation');
  }

  if (next.length > MAX_CONTENT_LENGTH) throw httpError(400, 'Canvas content must be text no longer than 100,000 characters');
  return { content: next, title: null };
}

module.exports = {
  parseSections,
  describeSections,
  applyOperation,
  checklistItems,
  OPERATIONS,
};
