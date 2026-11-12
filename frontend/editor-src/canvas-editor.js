// IT Avenue Workspace - the rich-text canvas editor (TipTap / ProseMirror) and our Markdown dialect.
//
// A canvas is still stored as Markdown. This module is the translation layer: Markdown in, a page people
// edit directly, Markdown out. It is bundled into src/vendor/canvas-editor.js by scripts/build-editor.js
// (global `ITAEditor`) and also loaded by the tests, which check that every block type survives a round trip.
//
// Dialect notes (what the rest of the app and the server rely on):
//   - checklists            "- [ ] item" / "- [x] item"
//   - callouts              "> [!info] Title" then "> body" lines (info, note, tip, warning, danger)
//   - pictures              "![name](file:<id>)" (only canvas files; remote images are never loaded)
//   - tables, headings, lists, quotes, code, dividers: plain GitHub-style Markdown
const { Editor, Node, mergeAttributes } = require('@tiptap/core');
const { NodeSelection, Plugin } = require('@tiptap/pm/state');
const { Decoration, DecorationSet } = require('@tiptap/pm/view');
const { StarterKit } = require('@tiptap/starter-kit');
const { Table, TableRow, TableHeader, TableCell } = require('@tiptap/extension-table');
const { TaskList, TaskItem } = require('@tiptap/extension-list');
const { Placeholder } = require('@tiptap/extensions');
const { Image } = require('@tiptap/extension-image');
const { Markdown } = require('@tiptap/markdown');

const CALLOUT_TYPES = ['info', 'note', 'tip', 'warning', 'danger'];
const CALLOUT_START = new RegExp(`^> \\[!(${CALLOUT_TYPES.join('|')})\\][ \\t]*([^\\n]*)`, 'i');

// A highlighted box. Its text is ordinary blocks; a title in the Markdown ("> [!info] Goal") becomes a
// bold first line, which is also how it is edited.
const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (el) => el.getAttribute('data-callout') || 'info',
        renderHTML: (attrs) => ({ 'data-callout': attrs.type }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'cw-callout' }, HTMLAttributes), 0];
  },

  markdownTokenizer: {
    name: 'callout',
    level: 'block',
    start: (src) => {
      const match = new RegExp(`(^|\\n)> \\[!(${CALLOUT_TYPES.join('|')})\\]`, 'i').exec(src);
      return match ? match.index + (match[1] ? 1 : 0) : -1;
    },
    tokenize(src, _tokens, lexer) {
      const first = CALLOUT_START.exec(src);
      if (!first) return undefined;
      const lines = src.split('\n');
      const taken = [];
      for (const line of lines) {
        if (!line.startsWith('>')) break;
        taken.push(line);
      }
      const body = taken.slice(1).map((line) => line.replace(/^> ?/, '')).join('\n');
      return {
        type: 'callout',
        raw: taken.join('\n'),
        calloutType: first[1].toLowerCase(),
        title: first[2].trim(),
        tokens: lexer.blockTokens(body),
      };
    },
  },

  parseMarkdown(token, helpers) {
    const children = helpers.parseChildren(token.tokens || []);
    if (token.title) {
      children.unshift({ type: 'paragraph', content: [{ type: 'text', text: token.title, marks: [{ type: 'bold' }] }] });
    }
    if (children.length === 0) children.push({ type: 'paragraph' });
    return helpers.createNode('callout', { type: token.calloutType || 'info' }, children);
  },

  renderMarkdown(node, helpers) {
    const body = helpers.renderChildren(node.content || [], '\n\n');
    const lines = body.split('\n').map((line) => (line ? `> ${line}` : '>'));
    return `> [!${node.attrs?.type || 'info'}]\n${lines.join('\n')}`;
  },
});

// Pictures are canvas files ("file:<id>"). The page never gets a URL for them: the app fetches each one with
// the signed-in request (data-cv-file), so a pasted or typed remote image is dropped instead of loaded.
// Size and alignment are kept in the standard Markdown image title: ![name](file:7 "50% center").
const FILE_SRC = /^file:(\d{1,10})$/;
const IMAGE_ALIGNS = ['left', 'center', 'right'];

function parseImageTitle(title) {
  const out = { width: null, align: 'left' };
  for (const part of String(title || '').trim().split(/\s+/)) {
    const percent = /^(\d{1,3})%$/.exec(part);
    if (percent) out.width = Math.min(100, Math.max(10, Number(percent[1])));
    else if (IMAGE_ALIGNS.includes(part)) out.align = part;
  }
  return out;
}

function imageTitle(attrs) {
  const parts = [];
  if (attrs.width && attrs.width < 100) parts.push(`${attrs.width}%`);
  if (attrs.align && attrs.align !== 'left') parts.push(attrs.align);
  return parts.join(' ');
}

const CanvasImage = Image.extend({
  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => (el.getAttribute('data-cv-file') ? `file:${el.getAttribute('data-cv-file')}` : null),
        renderHTML: () => ({}),
      },
      alt: { default: '' },
      width: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('data-width')) || null,
        renderHTML: () => ({}),
      },
      align: {
        default: 'left',
        parseHTML: (el) => (IMAGE_ALIGNS.includes(el.getAttribute('data-align')) ? el.getAttribute('data-align') : 'left'),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[data-cv-file]' }];
  },

  renderHTML({ node }) {
    const match = FILE_SRC.exec(node.attrs.src || '');
    const attrs = { 'data-cv-file': match ? match[1] : '', alt: node.attrs.alt || '', 'data-align': node.attrs.align || 'left' };
    if (node.attrs.width) attrs['data-width'] = String(node.attrs.width);
    return ['img', attrs];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('figure');
      dom.className = 'cw-image';
      const frame = document.createElement('div');
      frame.className = 'cw-image-frame';
      const img = document.createElement('img');
      const handle = document.createElement('span');
      handle.className = 'cw-image-handle';
      handle.title = 'Drag to resize';
      frame.append(img, handle);
      dom.appendChild(frame);

      const apply = (n) => {
        const match = FILE_SRC.exec(n.attrs.src || '');
        img.setAttribute('data-cv-file', match ? match[1] : '');
        img.alt = n.attrs.alt || '';
        img.title = n.attrs.alt || '';
        frame.style.width = n.attrs.width ? `${n.attrs.width}%` : '';
        dom.setAttribute('data-align', n.attrs.align || 'left');
      };
      apply(node);
      // the app fills in the picture with the signed-in request (features/canvas-view.js)
      const load = () => { if (typeof cvwLoadImages === 'function') cvwLoadImages(dom); };
      load();

      // drag the corner to resize, in steps of 5% of the page width
      handle.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const pageWidth = dom.getBoundingClientRect().width || 1;
        const startX = event.clientX;
        const startWidth = frame.getBoundingClientRect().width;
        let percent = Math.round((startWidth / pageWidth) * 100);
        const move = (e) => {
          percent = Math.max(10, Math.min(100, Math.round(((startWidth + e.clientX - startX) / pageWidth) * 20) * 5));
          frame.style.width = `${percent}%`;
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          const pos = getPos();
          if (typeof pos === 'number') {
            editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width: percent >= 100 ? null : percent }));
          }
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });

      return {
        dom,
        ignoreMutation: () => true,
        stopEvent: (event) => event.target === handle,
        update: (next) => {
          if (next.type !== node.type) return false;
          const sourceChanged = next.attrs.src !== current.attrs.src;
          current = next;
          apply(next);
          if (sourceChanged) load();
          return true;
        },
      };
    };
  },

  parseMarkdown(token, helpers) {
    if (!FILE_SRC.test(token.href || '')) return helpers.createTextNode(token.raw || '');
    const { width, align } = parseImageTitle(token.title);
    return helpers.createNode('image', { src: token.href, alt: token.text || '', width, align });
  },

  renderMarkdown(node) {
    const alt = String(node.attrs?.alt || '').replace(/[\[\]\n]/g, ' ').trim();
    const title = imageTitle(node.attrs || {});
    return `![${alt}](${node.attrs?.src || ''}${title ? ` "${title}"` : ''})`;
  },
});

// A table whose columns can be dragged wider or narrower. Markdown has no place for widths, so they are
// kept in the separator row, which renderers ignore: "| ------------ | ---- |" means roughly 120px and 40px
// (about 10px per dash; 3 dashes or fewer means "automatic").
const PX_PER_DASH = 10;
const baseTableParse = Table.config.parseMarkdown;
const baseTableRender = Table.config.renderMarkdown;

const CanvasTable = Table.extend({
  parseMarkdown(token, helpers) {
    const node = baseTableParse(token, helpers);
    const separator = String(token.raw || '').split('\n')[1] || '';
    const widths = separator.split('|').map((cell) => cell.trim()).filter(Boolean).map((cell) => {
      const dashes = (cell.match(/-/g) || []).length;
      return dashes > 3 ? Math.min(600, dashes * PX_PER_DASH) : null;
    });
    if (widths.some(Boolean)) {
      for (const row of node.content || []) {
        (row.content || []).forEach((cell, i) => {
          if (widths[i]) cell.attrs = { ...(cell.attrs || {}), colwidth: [widths[i]] };
        });
      }
    }
    return node;
  },

  renderMarkdown(node, helpers) {
    const markdown = baseTableRender(node, helpers);
    const first = (node.content && node.content[0] && node.content[0].content) || [];
    const widths = first.map((cell) => (cell.attrs && cell.attrs.colwidth && cell.attrs.colwidth[0]) || null);
    const lines = markdown.split('\n');
    const header = lines.findIndex((line) => line.trim().startsWith('|'));
    if (header < 0 || !lines[header + 1]) return markdown;
    const cells = lines[header + 1].split('|').map((cell) => cell.trim()).filter(Boolean);
    lines[header + 1] = `| ${cells.map((cell, i) => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      const dashes = widths[i] ? Math.max(4, Math.min(60, Math.round(widths[i] / PX_PER_DASH))) : 3;
      return `${left ? ':' : ''}${'-'.repeat(dashes)}${right ? ':' : ''}`;
    }).join(' | ')} |`;
    return lines.join('\n');
  },
});

// Start dragging a whole top-level block (a picture, a table, a paragraph...) from its handle. ProseMirror
// does the rest: it shows the drop line and moves the block where it is dropped.
function startBlockDrag(editor, blockElement, event) {
  const { view } = editor;
  const inside = view.posAtDOM(blockElement, 0);
  const $pos = view.state.doc.resolve(inside);
  const start = $pos.depth >= 1 ? $pos.before(1) : inside;
  const selection = NodeSelection.create(view.state.doc, start);
  view.dispatch(view.state.tr.setSelection(selection));
  view.dragging = { slice: selection.content(), move: true };
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData('text/plain', blockElement.textContent || ' ');
  event.dataTransfer.setDragImage(blockElement, 0, 0);
  return true;
}

// "@name" is one unit in the page. Saved as plain "@name" text, so old clients, search and notifications
// keep working. Next to other text it shows as a small chip; alone on a line it shows as a profile card
// (picture, name, job title, status, email) so readers know who is meant. The details come from the app
// through the global canvasMentionLookup(username), which returns the person or null.
const MENTION_RE = /^@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/;

function mentionDom(username) {
  const person = typeof canvasMentionLookup === 'function' ? canvasMentionLookup(username) : null;
  // shown as the full name when the person has one; what is saved is still @username
  const shownName = (person && typeof personName === 'function' ? personName(person) : '') || username;
  const root = document.createElement('span');
  root.className = `cw-mention${person ? ' cw-mention-known' : ''}`;
  root.setAttribute('data-mention', username);
  root.contentEditable = 'false';
  const color = (person && person.avatarColor) || '#6B21A8';
  const initial = (shownName[0] || '?').toUpperCase();

  const chip = document.createElement('span');
  chip.className = 'cw-mention-chip';
  const dot = document.createElement('span');
  dot.className = 'cw-mention-dot';
  dot.style.background = color;
  dot.textContent = initial;
  chip.append(dot, document.createTextNode(`@${shownName}`));
  root.appendChild(chip);

  if (person) {
    const card = document.createElement('span');
    card.className = 'cw-mention-card';
    const avatar = document.createElement('span');
    avatar.className = 'cw-mention-avatar';
    avatar.style.background = color;
    avatar.textContent = initial;
    if (person.id !== undefined) avatar.setAttribute('data-profile-user', String(person.id));
    // a profile photo replaces the initial once it has been fetched (the app provides canvasUserPhoto)
    if (person.photoVersion && typeof canvasUserPhoto === 'function') {
      Promise.resolve(canvasUserPhoto(person)).then((url) => {
        if (!url) return;
        avatar.style.backgroundImage = `url("${url}")`;
        avatar.style.backgroundSize = 'cover';
        avatar.style.backgroundPosition = 'center';
        avatar.textContent = '';
      }).catch(() => {});
    }
    const body = document.createElement('span');
    body.className = 'cw-mention-body';

    // name with a presence dot, then job title (or role), status and email
    const nameRow = document.createElement('span');
    nameRow.className = 'cw-mention-namerow';
    const name = document.createElement('span');
    name.className = 'cw-mention-name';
    name.textContent = shownName;
    if (person.id !== undefined) name.setAttribute('data-profile-user', String(person.id));
    const presence = document.createElement('span');
    presence.className = `cw-mention-presence${person.status === 'online' ? ' online' : ''}`;
    presence.title = person.status ? person.status[0].toUpperCase() + person.status.slice(1) : '';
    nameRow.append(name, presence);
    body.appendChild(nameRow);
    const line = (className, text) => {
      if (!text) return;
      const el = document.createElement('span');
      el.className = className;
      el.textContent = text;
      body.appendChild(el);
    };
    const role = person.accountType === 'guest' ? 'Guest' : person.isSuperadmin ? 'Superadmin' : '';
    line('cw-mention-title', [person.jobTitle, role].filter(Boolean).join(' · '));
    line('cw-mention-status', [person.statusEmoji, person.statusText].filter(Boolean).join(' '));
    line('cw-mention-email', person.email);

    // "Message" opens a direct message with them, "Huddle" starts a call (the app handles the clicks)
    if (person.id !== undefined && !person.isSelf) {
      const actions = document.createElement('span');
      actions.className = 'cw-mention-actions';
      const action = (attribute, className, label) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.setAttribute(attribute, String(person.id));
        button.textContent = label;
        actions.appendChild(button);
      };
      action('data-message-user', 'cw-mention-msg', '+ Message');
      action('data-huddle-user', 'cw-mention-msg cw-mention-huddle', '+ Huddle');
      body.appendChild(actions);
    }
    card.append(avatar, body);
    root.appendChild(card);
  }
  return root;
}

const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { username: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention]', getAttrs: (el) => ({ username: el.getAttribute('data-mention') }) }];
  },

  renderHTML({ node }) {
    return ['span', { 'data-mention': node.attrs.username, class: 'cw-mention-static' }, `@${node.attrs.username}`];
  },

  addNodeView() {
    return ({ node }) => {
      let name = node.attrs.username;
      let dom = mentionDom(name);
      return {
        dom,
        ignoreMutation: () => true,
        stopEvent: (event) => Boolean(event.target && event.target.closest && event.target.closest('.cw-mention-actions, [data-profile-user]')),
        update: (next) => {
          if (next.type !== node.type) return false;
          if (next.attrs.username !== name) return false;
          return true;
        },
      };
    };
  },

  // a paragraph holding only one mention (and maybe spaces) is marked, so it shows as a card
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        decorations(state) {
          const decorations = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'paragraph') return true;
            let mentions = 0;
            let other = false;
            node.forEach((child) => {
              if (child.type.name === 'mention') mentions += 1;
              else if (!(child.isText && !child.text.trim())) other = true;
            });
            if (mentions === 1 && !other) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'cw-mention-solo' }));
            return false;
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },

  markdownTokenizer: {
    name: 'mention',
    level: 'inline',
    start: (src) => {
      const match = /(^|[\s(])@[A-Za-z0-9_]/.exec(src);
      return match ? match.index + match[1].length : -1;
    },
    tokenize(src, tokens) {
      // only after whitespace, "(" or at the start: "ann@example.com" is an email, never a mention
      const previous = tokens && tokens.length ? tokens[tokens.length - 1] : null;
      const before = previous ? String(previous.raw || '').slice(-1) : '';
      if (before && !/[\s(]/.test(before)) return undefined;
      const match = MENTION_RE.exec(src);
      return match ? { type: 'mention', raw: match[0], username: match[1] } : undefined;
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode('mention', { username: token.username });
  },

  renderMarkdown(node) {
    return `@${node.attrs?.username || ''}`;
  },
});

function buildExtensions({ placeholder } = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      underline: false, // Markdown has no underline, so it could not be saved
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    CanvasTable.configure({ resizable: true, cellMinWidth: 60, handleWidth: 6, lastColumnResizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Callout,
    CanvasImage.configure({ inline: true }),
    Mention,
    Placeholder.configure({ placeholder: placeholder || "Write something, or press / for commands" }),
    Markdown,
  ];
}

function createCanvasEditor(element, options = {}) {
  const config = {
    element,
    extensions: buildExtensions(options),
    content: options.content || '',
    contentType: 'markdown',
    editable: options.editable !== false,
  };
  // only real callbacks: an undefined one would be registered as a listener and throw when it fires
  for (const name of ['onUpdate', 'onSelectionUpdate', 'onTransaction', 'onFocus', 'onBlur']) {
    if (typeof options[name] === 'function') config[name] = options[name];
  }
  return new Editor(config);
}

// Replace the whole page with this Markdown without making it an undo step: Ctrl+Z must undo what the
// person did, never the loading of the page (which would blank it or bring back the previous canvas).
function loadMarkdown(editor, markdown) {
  editor.chain().setMeta('addToHistory', false).setContent(markdown || '', { contentType: 'markdown', emitUpdate: false }).run();
}

// Markdown as saved: no leading or doubled blank lines (outside code fences) and one final newline.
function normalizeMarkdown(markdown) {
  const parts = String(markdown || '').split(/(```[\s\S]*?```)/g);
  const text = parts.map((part, i) => (i % 2 === 1 ? part : part.replace(/\n{3,}/g, '\n\n'))).join('');
  const trimmed = text.replace(/^\n+/, '').replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n` : '';
}

function getCanvasMarkdown(editor) {
  return normalizeMarkdown(editor.getMarkdown());
}

// Column widths (px) that fit the page: natural widths if they already fit, otherwise scaled down
// together, never below `min`. Used by "Auto-fit to contents".
function fitColumnWidths(natural, available, min = 60) {
  const widths = natural.map((w) => Math.max(min, Math.ceil(w)));
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= available || available <= 0) return widths;
  // shrink the columns that have room above the minimum, in proportion to that room
  const room = widths.map((w) => w - min);
  const roomTotal = room.reduce((sum, r) => sum + r, 0);
  const excess = total - available;
  if (roomTotal <= 0) return widths;
  const cut = Math.min(1, excess / roomTotal);
  return widths.map((w, i) => Math.max(min, Math.floor(w - room[i] * cut)));
}

module.exports = { createCanvasEditor, buildExtensions, loadMarkdown, getCanvasMarkdown, normalizeMarkdown, parseImageTitle, imageTitle, startBlockDrag, fitColumnWidths, CALLOUT_TYPES };
