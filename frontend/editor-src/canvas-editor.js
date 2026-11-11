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
const FILE_SRC = /^file:(\d{1,10})$/;

const CanvasImage = Image.extend({
  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => (el.getAttribute('data-cv-file') ? `file:${el.getAttribute('data-cv-file')}` : null),
        renderHTML: () => ({}),
      },
      alt: { default: '' },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'img[data-cv-file]' }];
  },

  renderHTML({ node }) {
    const match = FILE_SRC.exec(node.attrs.src || '');
    return ['img', { 'data-cv-file': match ? match[1] : '', alt: node.attrs.alt || '' }];
  },

  addNodeView() {
    return ({ node }) => {
      const match = FILE_SRC.exec(node.attrs.src || '');
      const dom = document.createElement('figure');
      dom.className = 'cw-image';
      const img = document.createElement('img');
      img.setAttribute('data-cv-file', match ? match[1] : '');
      img.alt = node.attrs.alt || '';
      dom.appendChild(img);
      // the app fills in the picture with the signed-in request (features/canvas-view.js)
      if (typeof cvwLoadImages === 'function') cvwLoadImages(dom);
      return {
        dom,
        ignoreMutation: () => true,
        update: (next) => next.type === node.type && next.attrs.src === node.attrs.src && ((img.alt = next.attrs.alt || ''), true),
      };
    };
  },

  parseMarkdown(token, helpers) {
    if (!FILE_SRC.test(token.href || '')) return helpers.createTextNode(token.raw || '');
    return helpers.createNode('image', { src: token.href, alt: token.text || '' });
  },

  renderMarkdown(node) {
    const alt = String(node.attrs?.alt || '').replace(/[\[\]\n]/g, ' ').trim();
    return `![${alt}](${node.attrs?.src || ''})`;
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
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Callout,
    CanvasImage,
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

module.exports = { createCanvasEditor, buildExtensions, getCanvasMarkdown, normalizeMarkdown, CALLOUT_TYPES };
