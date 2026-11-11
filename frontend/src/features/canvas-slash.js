// IT Avenue Workspace - Canvas editor helpers: slash menu, list continuation, formatting shortcuts.
//
// Type "/" at the start of a line to open a menu of blocks (headings, lists, checklist, table, callouts...).
// "/h1 My title" + Enter turns the line into "# My title". Enter inside a list continues it, and Enter on
// an empty bullet ends it. Ctrl+B / Ctrl+I / Ctrl+K wrap the selection. Everything stays plain Markdown,
// so the textarea, autosave, history and the reading view are unchanged.
//
// The text logic below is pure (no DOM) and covered by test/canvas-slash.test.js.

const SLASH_ITEMS = [
  { id: 'h1', label: 'Heading 1', hint: 'Big section title', keys: ['h1', 'heading', 'title'], prefix: '# ' },
  { id: 'h2', label: 'Heading 2', hint: 'Medium heading', keys: ['h2', 'heading'], prefix: '## ' },
  { id: 'h3', label: 'Heading 3', hint: 'Small heading', keys: ['h3', 'heading'], prefix: '### ' },
  { id: 'text', label: 'Text', hint: 'Plain paragraph', keys: ['text', 'paragraph', 'p'], prefix: '' },
  { id: 'list', label: 'Bulleted list', hint: 'A simple list', keys: ['list', 'bullet', 'bullets', 'ul'], prefix: '- ' },
  { id: 'numbered', label: 'Numbered list', hint: '1. 2. 3.', keys: ['numbered', 'number', 'ol', 'ordered'], prefix: '1. ' },
  { id: 'todo', label: 'Checklist', hint: 'Items you can tick off', keys: ['todo', 'task', 'tasks', 'checklist', 'check'], prefix: '- [ ] ' },
  { id: 'quote', label: 'Quote', hint: 'Set a passage apart', keys: ['quote', 'blockquote'], prefix: '> ' },
  { id: 'info', label: 'Info callout', hint: 'Highlighted note', keys: ['info', 'callout', 'note'], callout: 'info' },
  { id: 'tip', label: 'Tip callout', hint: 'Helpful suggestion', keys: ['tip', 'callout'], callout: 'tip' },
  { id: 'warning', label: 'Warning callout', hint: 'Needs attention', keys: ['warning', 'warn', 'callout'], callout: 'warning' },
  { id: 'danger', label: 'Danger callout', hint: 'Risky or critical', keys: ['danger', 'error', 'callout'], callout: 'danger' },
  { id: 'table', label: 'Table', hint: '2 columns, ready to fill', keys: ['table', 'grid'], table: true },
  { id: 'code', label: 'Code block', hint: 'Monospaced text', keys: ['code', 'snippet', 'pre'], code: true },
  { id: 'divider', label: 'Divider', hint: 'A horizontal line', keys: ['divider', 'line', 'hr', 'rule'], divider: true },
  { id: 'date', label: 'Today’s date', hint: 'Insert the date', keys: ['date', 'today'], date: true },
  { id: 'mention', label: 'Mention someone', hint: 'Type @ then a name', keys: ['mention', 'at', 'person'], mention: true },
];

// Menu entries matching what was typed after "/" (empty query = everything, in menu order).
function filterSlashItems(query) {
  const q = String(query || '').toLowerCase();
  if (!q) return SLASH_ITEMS.slice();
  const score = (item) => {
    if (item.id === q || item.keys[0] === q) return 0;
    if (item.keys.some((k) => k === q)) return 1;
    if (item.keys.some((k) => k.startsWith(q))) return 2;
    if (item.label.toLowerCase().includes(q)) return 3;
    return 9;
  };
  return SLASH_ITEMS
    .map((item, order) => ({ item, order, s: score(item) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.order - b.order)
    .map((x) => x.item);
}

function slashItemById(id) {
  return SLASH_ITEMS.find((item) => item.id === id) || null;
}

// The line the cursor is on: { start, end, text } (end excludes the newline).
function lineAt(value, cursor) {
  const start = value.lastIndexOf('\n', cursor - 1) + 1;
  let end = value.indexOf('\n', cursor);
  if (end === -1) end = value.length;
  return { start, end, text: value.slice(start, end) };
}

// Is the cursor in a "/command" that should show the menu? Returns { query, start } or null.
// Only when "/" starts the line (indentation allowed) and nothing but a command word follows up to the cursor.
function slashTrigger(value, cursor) {
  const line = lineAt(value, cursor);
  const before = value.slice(line.start, cursor);
  const m = /^(\s*)\/([a-z0-9]*)$/i.exec(before);
  if (!m) return null;
  return { query: m[2], start: line.start + m[1].length, indent: m[1] };
}

// "/h1 My title" -> { item, text } when the whole line is a known command followed by text.
function parseSlashLine(lineText) {
  const m = /^(\s*)\/([a-z0-9]+)(?:\s+(.*))?$/i.exec(lineText);
  if (!m) return null;
  const command = m[2].toLowerCase();
  const item = SLASH_ITEMS.find((it) => it.id === command || it.keys.includes(command));
  if (!item) return null;
  return { item, text: (m[3] || '').trim(), indent: m[1] };
}

// Build what replaces the line. `text` is anything the user typed after the command.
// Returns { insert, selectStart, selectEnd } with the selection relative to the start of `insert`.
function buildSlashInsert(item, text, today) {
  const t = text || '';
  if (item.table) {
    const header = '| Column 1 | Column 2 |';
    const insert = `${header}\n| --- | --- |\n|  |  |`;
    return { insert, selectStart: 2, selectEnd: 10 };
  }
  if (item.code) {
    const insert = `\`\`\`\n${t}\n\`\`\``;
    return { insert, selectStart: 4, selectEnd: 4 + t.length };
  }
  if (item.divider) {
    return { insert: '---', selectStart: 3, selectEnd: 3, after: '\n' };
  }
  if (item.callout) {
    const head = `> [!${item.callout}]`;
    const insert = `${head}\n> ${t}`;
    return { insert, selectStart: insert.length, selectEnd: insert.length };
  }
  if (item.date) {
    const d = today || new Date().toISOString().slice(0, 10);
    return { insert: d, selectStart: d.length, selectEnd: d.length };
  }
  if (item.mention) {
    return { insert: `@${t}`, selectStart: 1 + t.length, selectEnd: 1 + t.length };
  }
  const insert = `${item.prefix}${t}`;
  return { insert, selectStart: insert.length, selectEnd: insert.length };
}

// Apply a menu item to the line the cursor is on. Returns { value, selectStart, selectEnd }.
function applySlashItem(value, cursor, item, options = {}) {
  const line = lineAt(value, cursor);
  const indent = /^\s*/.exec(line.text)[0];
  const built = buildSlashInsert(item, options.text || '', options.today);
  const body = indent && !item.table && !item.code ? indent + built.insert : built.insert;
  const shift = indent && !item.table && !item.code ? indent.length : 0;
  const after = value.slice(line.end);
  // a divider ends its line and the cursor moves on to the next one
  const extra = built.after && !after.startsWith('\n') ? '\n' : '';
  const next = value.slice(0, line.start) + body + extra + after;
  const base = line.start + shift;
  let selectStart = base + built.selectStart;
  let selectEnd = base + built.selectEnd;
  if (built.after) { selectStart = selectEnd = line.start + body.length + 1; }
  return { value: next, selectStart, selectEnd };
}

const LIST_PREFIX = /^(\s*)((?:[-*+] \[[ xX]\] )|(?:[-*+] )|(?:(\d+)\. ))(.*)$/;

// Enter at the end of a list line: continue the list, or end it when the item is empty.
// Returns { value, selectStart, selectEnd } or null when this is not a list line.
function continueList(value, cursor) {
  const line = lineAt(value, cursor);
  if (cursor !== line.end) return null;
  const m = LIST_PREFIX.exec(line.text);
  if (!m) return null;
  const [, indent, marker, number, rest] = m;
  if (rest.trim() === '') {
    // empty item: remove the marker and leave an empty line, which ends the list
    const next = value.slice(0, line.start) + value.slice(line.end);
    return { value: next, selectStart: line.start, selectEnd: line.start };
  }
  let nextMarker = marker;
  if (number !== undefined) nextMarker = `${Number(number) + 1}. `;
  else if (/\[[ xX]\]/.test(marker)) nextMarker = marker.replace(/\[[xX]\]/, '[ ]');
  const insert = `\n${indent}${nextMarker}`;
  const next = value.slice(0, cursor) + insert + value.slice(cursor);
  const pos = cursor + insert.length;
  return { value: next, selectStart: pos, selectEnd: pos };
}

// Ctrl+B / Ctrl+I / Ctrl+K style wrapping of the selection.
function wrapSelection(value, start, end, kind) {
  const selected = value.slice(start, end);
  if (kind === 'link') {
    const label = selected || 'link text';
    const insert = `[${label}](https://)`;
    const urlStart = start + label.length + 3;
    return { value: value.slice(0, start) + insert + value.slice(end), selectStart: urlStart, selectEnd: urlStart + 8 };
  }
  const mark = kind === 'bold' ? '**' : '*';
  if (selected.startsWith(mark) && selected.endsWith(mark) && selected.length >= mark.length * 2) {
    const inner = selected.slice(mark.length, selected.length - mark.length);
    return { value: value.slice(0, start) + inner + value.slice(end), selectStart: start, selectEnd: start + inner.length };
  }
  const insert = `${mark}${selected}${mark}`;
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    selectStart: start + mark.length,
    selectEnd: start + mark.length + selected.length,
  };
}

// ---------------------------------------------------------------------------------------------
// DOM layer
// ---------------------------------------------------------------------------------------------

function attachCanvasSlash(textarea) {
  if (!textarea || textarea.dataset.slashAttached) return;
  textarea.dataset.slashAttached = '1';

  let menu = null;
  let matches = [];
  let active = 0;
  let trigger = null;

  const closeMenu = () => {
    if (menu) menu.remove();
    menu = null;
    matches = [];
    trigger = null;
  };

  const commit = (result) => {
    textarea.value = result.value;
    textarea.setSelectionRange(result.selectStart, result.selectEnd);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  };

  // Pixel position of the caret, using a hidden copy of the textarea.
  const caretRect = () => {
    const rect = textarea.getBoundingClientRect();
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'tabSize']) {
      mirror.style[prop] = style[prop];
    }
    mirror.style.position = 'fixed';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.left = '-9999px';
    mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const top = marker.offsetTop - textarea.scrollTop;
    const left = marker.offsetLeft - textarea.scrollLeft;
    const lineHeight = parseFloat(style.lineHeight) || 20;
    mirror.remove();
    return { x: rect.left + left, y: rect.top + top, lineHeight };
  };

  const renderMenu = () => {
    if (!matches.length) { closeMenu(); return; }
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'slash-menu';
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', 'Insert a block');
      document.body.appendChild(menu);
    }
    menu.innerHTML = matches.map((item, i) => `
      <button type="button" class="slash-item${i === active ? ' active' : ''}" role="option" aria-selected="${i === active}" data-slash="${item.id}">
        <span class="slash-label">${item.label}</span>
        <span class="slash-hint">${item.hint}</span>
        <span class="slash-key">/${item.keys[0]}</span>
      </button>`).join('');
    const caret = caretRect();
    const height = menu.offsetHeight;
    const width = menu.offsetWidth;
    const left = Math.max(8, Math.min(caret.x, window.innerWidth - width - 8));
    let top = caret.y + caret.lineHeight + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, caret.y - height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const current = menu.querySelector('.slash-item.active');
    if (current) current.scrollIntoView({ block: 'nearest' });
  };

  const refresh = () => {
    if (textarea.selectionStart !== textarea.selectionEnd) { closeMenu(); return; }
    trigger = slashTrigger(textarea.value, textarea.selectionStart);
    if (!trigger) { closeMenu(); return; }
    matches = filterSlashItems(trigger.query);
    active = 0;
    renderMenu();
  };

  const choose = (item) => {
    const cursor = textarea.selectionStart;
    closeMenu();
    commit(applySlashItem(textarea.value, cursor, item));
  };

  textarea.addEventListener('input', refresh);
  textarea.addEventListener('click', refresh);
  textarea.addEventListener('blur', () => setTimeout(closeMenu, 120));
  textarea.addEventListener('scroll', () => { if (menu) renderMenu(); });

  textarea.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (menu && matches.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); active = (active + 1) % matches.length; renderMenu(); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); active = (active - 1 + matches.length) % matches.length; renderMenu(); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(matches[active]); return; }
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
    }
    if (event.ctrlKey || event.metaKey) {
      const kind = { b: 'bold', i: 'italic', k: 'link' }[event.key.toLowerCase()];
      if (kind) {
        event.preventDefault();
        commit(wrapSelection(textarea.value, textarea.selectionStart, textarea.selectionEnd, kind));
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && textarea.selectionStart === textarea.selectionEnd) {
      const cursor = textarea.selectionStart;
      const line = lineAt(textarea.value, cursor);
      // "/h1 text" typed in full, then Enter
      if (cursor === line.end) {
        const parsed = parseSlashLine(line.text);
        if (parsed && parsed.text) {
          event.preventDefault();
          commit(applySlashItem(textarea.value, cursor, parsed.item, { text: parsed.text }));
          return;
        }
      }
      const next = continueList(textarea.value, cursor);
      if (next) {
        event.preventDefault();
        commit(next);
      }
    }
  });

  document.addEventListener('mousedown', (event) => {
    const button = event.target.closest ? event.target.closest('.slash-item') : null;
    if (!button || !menu || !menu.contains(button)) return;
    event.preventDefault();
    const item = slashItemById(button.dataset.slash);
    if (item) choose(item);
  });
}

// ---------------------------------------------------------------------------------------------
// Formatting toolbar (buttons for the same things). Pure part first.
// ---------------------------------------------------------------------------------------------

const TOOLBAR_BUTTONS = [
  { id: 'bold', label: 'B', title: 'Bold (Ctrl+B)', style: 'bold' },
  { id: 'italic', label: 'I', title: 'Italic (Ctrl+I)', style: 'italic' },
  { id: 'link', label: 'Link', title: 'Link (Ctrl+K)' },
  { sep: true },
  { id: 'h1', label: 'H1', title: 'Heading 1' },
  { id: 'h2', label: 'H2', title: 'Heading 2' },
  { id: 'h3', label: 'H3', title: 'Heading 3' },
  { sep: true },
  { id: 'list', label: '• List', title: 'Bulleted list' },
  { id: 'numbered', label: '1. List', title: 'Numbered list' },
  { id: 'todo', label: '☑ Todo', title: 'Checklist' },
  { id: 'quote', label: 'Quote', title: 'Quote' },
  { sep: true },
  { id: 'table', label: 'Table', title: 'Insert a table' },
  { id: 'code', label: 'Code', title: 'Insert a code block' },
  { id: 'tip', label: 'Callout', title: 'Insert a callout' },
  { id: 'divider', label: 'Divider', title: 'Insert a divider' },
];

const LINE_MARKER = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+\. |> )/;

// What a toolbar button does to the text. Returns { value, selectStart, selectEnd }.
function toolbarAction(value, start, end, id) {
  if (id === 'bold' || id === 'italic' || id === 'link') return wrapSelection(value, start, end, id);
  const item = slashItemById(id);
  if (!item) return { value, selectStart: start, selectEnd: end };
  const line = lineAt(value, start);
  if (item.prefix !== undefined && item.prefix !== '') {
    // headings, lists, quote: set the line's marker; pressing the same button again removes it
    const m = LINE_MARKER.exec(line.text);
    const indent = m ? m[1] : /^\s*/.exec(line.text)[0];
    const current = m ? m[2] : '';
    const rest = line.text.slice(indent.length + current.length);
    const same = current === item.prefix || (id === 'numbered' && /^\d+\. $/.test(current));
    const marker = same ? '' : item.prefix;
    const text = indent + marker + rest;
    const delta = text.length - line.text.length;
    return {
      value: value.slice(0, line.start) + text + value.slice(line.end),
      selectStart: Math.max(line.start, start + delta),
      selectEnd: Math.max(line.start, end + delta),
    };
  }
  // table, code, callout, divider: a new block after the current line, separated by a blank line
  const built = buildSlashInsert(item, '');
  const emptyLine = line.text.trim() === '';
  const lead = emptyLine ? '' : '\n\n';
  const at = emptyLine ? line.start : line.end;
  const tail = at === value.length ? '\n' : '';
  const insert = lead + built.insert + tail;
  const offset = at + lead.length;
  return {
    value: value.slice(0, at) + insert + value.slice(emptyLine ? line.end : at),
    selectStart: offset + built.selectStart,
    selectEnd: offset + built.selectEnd,
  };
}

// ---------------------------------------------------------------------------------------------
// Toolbar DOM: one bar per editor, shown only while the editor is in Edit mode and the user has it on.
// The on/off choice is remembered per person on this computer.
// ---------------------------------------------------------------------------------------------

const CANVAS_TOOLBAR_KEY = 'canvasToolbar';
const canvasToolbars = [];

function canvasToolbarEnabled() {
  try { return localStorage.getItem(CANVAS_TOOLBAR_KEY) !== 'off'; } catch (e) { return true; }
}

function setCanvasToolbarEnabled(on) {
  try { localStorage.setItem(CANVAS_TOOLBAR_KEY, on ? 'on' : 'off'); } catch (e) { /* storage unavailable: just not remembered */ }
  canvasToolbars.forEach((bar) => bar.sync());
}

function attachCanvasToolbar(textarea, modeButton) {
  if (!textarea || textarea.dataset.toolbarAttached) return;
  textarea.dataset.toolbarAttached = '1';

  const bar = document.createElement('div');
  bar.className = 'canvas-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');
  bar.innerHTML = TOOLBAR_BUTTONS.map((b) => (b.sep
    ? '<span class="canvas-toolbar-sep" aria-hidden="true"></span>'
    : `<button type="button" class="canvas-toolbar-btn ${b.style || ''}" data-fmt="${b.id}" title="${b.title}" aria-label="${b.title}">${b.label}</button>`)).join('');
  textarea.parentNode.insertBefore(bar, textarea);

  // keep the selection in the textarea while a button is pressed
  bar.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
  bar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-fmt]');
    if (!button) return;
    const result = toolbarAction(textarea.value, textarea.selectionStart, textarea.selectionEnd, button.dataset.fmt);
    textarea.value = result.value;
    textarea.focus();
    textarea.setSelectionRange(result.selectStart, result.selectEnd);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn canvas-mode-btn canvas-toolbar-toggle';
  toggle.textContent = 'Aa';
  if (modeButton && modeButton.parentNode) modeButton.parentNode.insertBefore(toggle, modeButton);
  toggle.addEventListener('click', () => setCanvasToolbarEnabled(!canvasToolbarEnabled()));

  const sync = () => {
    const editing = !textarea.hidden && !textarea.readOnly;
    const on = canvasToolbarEnabled();
    bar.hidden = !(editing && on);
    toggle.hidden = !editing;
    toggle.classList.toggle('active', on);
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggle.title = on ? 'Hide the formatting toolbar' : 'Show the formatting toolbar';
  };
  new MutationObserver(sync).observe(textarea, { attributes: true, attributeFilter: ['hidden', 'readonly'] });
  canvasToolbars.push({ sync });
  sync();
}

if (typeof document !== 'undefined') {
  // Scripts load at the end of <body>, so both editors already exist.
  const sheet = document.getElementById('canvas-sheet-editor');
  const standalone = document.getElementById('canvas2-editor');
  attachCanvasSlash(sheet);
  attachCanvasSlash(standalone);
  attachCanvasToolbar(sheet, document.getElementById('btn-canvas-sheet-mode'));
  attachCanvasToolbar(standalone, document.getElementById('btn-canvas2-mode'));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SLASH_ITEMS, filterSlashItems, slashTrigger, parseSlashLine, applySlashItem, continueList, wrapSelection, lineAt,
    toolbarAction, TOOLBAR_BUTTONS,
  };
}
