// IT Avenue Workspace - the editable canvas page (rich text).
//
// People edit the finished page directly: headings, lists, checklists, tables, callouts, pictures. The
// text is still saved as Markdown, so history, comments, sections, the API and old clients are unaffected.
//
// How it fits the existing code: each canvas view still has a hidden <textarea> (features/canvas-view.js,
// renderer.js) that holds the Markdown and drives autosave. This page keeps it in step:
//   - editing the page  -> the textarea gets the Markdown and an `input` event (autosave does the rest);
//   - the app setting textarea.value (opening a canvas, a remote update, a restore) -> the page reloads it.
// The "Markdown" button switches to the textarea itself, for anyone who prefers the source.
//
// Needs (loaded before): vendor/canvas-editor.js (ITAEditor), canvas-slash.js, canvas-view.js.

const canvasWysiwyg = (() => {
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const instances = {};

  const TOOLS = [
    { id: 'bold', label: 'B', cls: 'bold', title: 'Bold (Ctrl+B)', active: (e) => e.isActive('bold'), run: (c) => c.toggleBold() },
    { id: 'italic', label: 'I', cls: 'italic', title: 'Italic (Ctrl+I)', active: (e) => e.isActive('italic'), run: (c) => c.toggleItalic() },
    { id: 'strike', label: 'S', cls: 'strike', title: 'Strikethrough', active: (e) => e.isActive('strike'), run: (c) => c.toggleStrike() },
    { id: 'link', label: 'Link', title: 'Link (Ctrl+K)', active: (e) => e.isActive('link'), run: null },
    { sep: true },
    { id: 'h1', label: 'H1', title: 'Heading 1', active: (e) => e.isActive('heading', { level: 1 }), run: (c) => c.toggleHeading({ level: 1 }) },
    { id: 'h2', label: 'H2', title: 'Heading 2', active: (e) => e.isActive('heading', { level: 2 }), run: (c) => c.toggleHeading({ level: 2 }) },
    { id: 'h3', label: 'H3', title: 'Heading 3', active: (e) => e.isActive('heading', { level: 3 }), run: (c) => c.toggleHeading({ level: 3 }) },
    { sep: true },
    { id: 'list', label: '• List', title: 'Bulleted list', active: (e) => e.isActive('bulletList'), run: (c) => c.toggleBulletList() },
    { id: 'numbered', label: '1. List', title: 'Numbered list', active: (e) => e.isActive('orderedList'), run: (c) => c.toggleOrderedList() },
    { id: 'todo', label: '☑ Todo', title: 'Checklist', active: (e) => e.isActive('taskList'), run: (c) => c.toggleTaskList() },
    { id: 'quote', label: 'Quote', title: 'Quote', active: (e) => e.isActive('blockquote'), run: (c) => c.toggleBlockquote() },
    { sep: true },
    { id: 'table', label: 'Table', title: 'Insert a table', run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
    { id: 'image', label: 'Image', title: 'Insert an image', run: null },
    { id: 'code', label: 'Code', title: 'Code block', active: (e) => e.isActive('codeBlock'), run: (c) => c.toggleCodeBlock() },
    { id: 'callout', label: 'Callout', title: 'Callout', active: (e) => e.isActive('callout'), run: (c) => c.toggleWrap ? c.toggleWrap('callout', { type: 'info' }) : c.wrapIn('callout', { type: 'info' }) },
    { id: 'divider', label: 'Divider', title: 'Divider', run: (c) => c.setHorizontalRule() },
    { sep: true },
    { id: 'undo', label: '↶', title: 'Undo (Ctrl+Z)', run: (c) => c.undo() },
    { id: 'redo', label: '↷', title: 'Redo (Ctrl+Y)', run: (c) => c.redo() },
  ];

  const TABLE_TOOLS = [
    { id: 'rowAfter', label: '+ Row', title: 'Add a row below', run: (c) => c.addRowAfter() },
    { id: 'colAfter', label: '+ Column', title: 'Add a column to the right', run: (c) => c.addColumnAfter() },
    { id: 'rowDelete', label: '− Row', title: 'Delete this row', run: (c) => c.deleteRow() },
    { id: 'colDelete', label: '− Column', title: 'Delete this column', run: (c) => c.deleteColumn() },
    { id: 'tableDelete', label: 'Delete table', title: 'Delete the table', run: (c) => c.deleteTable() },
  ];

  const CALLOUT_TOOLS = ['info', 'tip', 'warning', 'danger'].map((type) => ({
    id: `callout-${type}`, label: type[0].toUpperCase() + type.slice(1), title: `Make this a ${type} callout`, type,
  }));

  // Slash menu entries -> editor commands.
  const SLASH_RUN = {
    h1: (c) => c.setHeading({ level: 1 }),
    h2: (c) => c.setHeading({ level: 2 }),
    h3: (c) => c.setHeading({ level: 3 }),
    text: (c) => c.setParagraph(),
    list: (c) => c.toggleBulletList(),
    numbered: (c) => c.toggleOrderedList(),
    todo: (c) => c.toggleTaskList(),
    quote: (c) => c.toggleBlockquote(),
    info: (c) => c.wrapIn('callout', { type: 'info' }),
    tip: (c) => c.wrapIn('callout', { type: 'tip' }),
    warning: (c) => c.wrapIn('callout', { type: 'warning' }),
    danger: (c) => c.wrapIn('callout', { type: 'danger' }),
    table: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
    code: (c) => c.toggleCodeBlock(),
    divider: (c) => c.setHorizontalRule(),
    date: (c) => c.insertContent(new Date().toISOString().slice(0, 10)),
    mention: (c) => c.insertContent('@'),
  };
  // commands where text typed after "/cmd " belongs inside the new block
  const TEXT_ITEMS = new Set(['h1', 'h2', 'h3', 'text', 'list', 'numbered', 'todo', 'quote', 'info', 'tip', 'warning', 'danger', 'code']);

  // The floating bars keep related actions together in dropdown menus.
  const IMAGE_BAR = [
    { menu: 'Size', items: [['width:25', 'Small (25%)'], ['width:50', 'Medium (50%)'], ['width:75', 'Large (75%)'], ['width:100', 'Full width']] },
    { menu: 'Align', items: [['align:left', 'Align left'], ['align:center', 'Center'], ['align:right', 'Align right']] },
    { act: 'alt', label: 'Description', title: 'Describe the picture' },
    { act: 'replace', label: 'Replace', title: 'Replace with another picture' },
    { act: 'delete', label: 'Delete', title: 'Remove the picture', danger: true },
  ];
  const TABLE_BAR = [
    { menu: 'Row', items: [['rowBefore', 'Insert row above'], ['rowAfter', 'Insert row below'], ['rowDelete', 'Delete row']] },
    { menu: 'Column', items: [['colBefore', 'Insert column left'], ['colAfter', 'Insert column right'], ['colDelete', 'Delete column']] },
    { menu: 'Widths', items: [['equalize', 'Equalize all columns'], ['autofit', 'Auto-fit to contents']] },
    { menu: 'Align', items: [['alignLeft', 'Align column left'], ['alignCenter', 'Center column'], ['alignRight', 'Align column right']] },
    { act: 'header', label: 'Header row', title: 'Turn the header row on or off' },
    { act: 'tableDelete', label: 'Delete table', title: 'Delete the whole table', danger: true },
  ];

  function barHtml(spec) {
    return spec.map((entry) => (entry.menu
      ? `<span class="cw-menu-wrap"><button type="button" class="canvas-toolbar-btn cw-menu-toggle" data-menu-toggle aria-haspopup="true" aria-expanded="false">${entry.menu} <span aria-hidden="true">\u25BE</span></button>`
        + `<div class="cw-menu" role="menu" hidden>${entry.items.map(([act, label]) => `<button type="button" role="menuitem" class="cw-menu-item" data-act="${act}">${label}</button>`).join('')}</div></span>`
      : `<button type="button" class="canvas-toolbar-btn${entry.danger ? ' danger' : ''}" data-act="${entry.act}" title="${entry.title || entry.label}">${entry.label}</button>`)).join('');
  }

  function closeMenus(bar) {
    bar.querySelectorAll('.cw-menu').forEach((menu) => { menu.hidden = true; });
    bar.querySelectorAll('[data-menu-toggle]').forEach((toggle) => toggle.setAttribute('aria-expanded', 'false'));
  }

  const make = (tag, className, attrs = {}) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };

  const toolButton = (tool) => {
    if (tool.sep) return make('span', 'canvas-toolbar-sep', { 'aria-hidden': 'true' });
    const button = make('button', `canvas-toolbar-btn ${tool.cls || ''}`, { type: 'button', 'data-tool': tool.id, title: tool.title, 'aria-label': tool.title });
    button.textContent = tool.label;
    return button;
  };

  function ensure(which) {
    if (instances[which]) return instances[which];
    const view = canvasViews[which];
    const container = view.render();
    const ta = view.editor();
    const inst = { which, container, ta, editor: null, lastWritten: null, loading: false, showing: false, menu: null };
    instances[which] = inst;

    container.innerHTML = '';
    container.classList.add('cw-host');
    inst.toolbar = make('div', 'cw-toolbar', { role: 'toolbar', 'aria-label': 'Formatting' });
    TOOLS.forEach((tool) => inst.toolbar.appendChild(toolButton(tool)));
    inst.contextual = make('div', 'cw-context');
    inst.contextual.hidden = true;
    inst.calloutBar = make('span', 'cw-callout-types');
    CALLOUT_TOOLS.forEach((tool) => { const b = toolButton(tool); b.dataset.calloutType = tool.type; inst.calloutBar.appendChild(b); });
    inst.contextual.appendChild(inst.calloutBar);
    inst.linkForm = make('form', 'cw-link-form');
    inst.linkForm.hidden = true;
    inst.linkForm.innerHTML = '<input type="text" placeholder="https://…" aria-label="Link address"><button class="btn primary" type="submit">Apply</button><button class="btn" type="button" data-link-remove>Remove link</button>';
    inst.strip = make('div', 'canvas-templates cw-templates');
    inst.strip.hidden = true;
    inst.strip.innerHTML = `<span class="canvas-templates-title">Start from a template</span>${CANVAS_TEMPLATES.map((tpl) => `
      <button type="button" class="canvas-template" data-template="${tpl.id}"><strong>${tpl.label}</strong><span>${tpl.hint}</span></button>`).join('')}`;
    inst.scroll = make('div', 'cw-scroll');
    inst.mount = make('div', 'cw-editor');
    inst.bubble = make('button', 'cv-comment-btn cw-bubble', { type: 'button', title: 'Comment on this', 'aria-label': 'Comment on this' });
    inst.bubble.hidden = true;
    inst.bubble.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    inst.imageBar = make('div', 'cw-float cw-image-bar', { role: 'toolbar', 'aria-label': 'Picture' });
    inst.imageBar.hidden = true;
    inst.imageBar.innerHTML = barHtml(IMAGE_BAR)
      + '<form class="cw-alt-form" hidden><input type="text" maxlength="200" placeholder="Describe the picture" aria-label="Picture description"><button class="btn primary" type="submit">Save</button></form>';
    inst.tableBar = make('div', 'cw-float cw-table-bar', { role: 'toolbar', 'aria-label': 'Table' });
    inst.tableBar.hidden = true;
    inst.tableBar.innerHTML = barHtml(TABLE_BAR);
    inst.addCol = make('button', 'cw-add-handle cw-add-col', { type: 'button', title: 'Add a column', 'aria-label': 'Add a column' });
    inst.addRow = make('button', 'cw-add-handle cw-add-row', { type: 'button', title: 'Add a row', 'aria-label': 'Add a row' });
    inst.addCol.textContent = '+';
    inst.addRow.textContent = '+';
    inst.addCol.hidden = true;
    inst.addRow.hidden = true;
    inst.grip = make('button', 'cw-grip', { type: 'button', title: 'Drag to move', 'aria-label': 'Drag to move this block', draggable: 'true' });
    inst.grip.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
    inst.grip.hidden = true;
    inst.scroll.append(inst.mount, inst.bubble, inst.imageBar, inst.tableBar, inst.addCol, inst.addRow, inst.grip);
    container.append(inst.toolbar, inst.contextual, inst.linkForm, inst.strip, inst.scroll);

    inst.editor = ITAEditor.createCanvasEditor(inst.mount, {
      content: '',
      editable: true, // created editable so the table column-resize plugin is active; show() locks it for viewers
      onUpdate: () => onEdited(inst),
      onTransaction: () => refreshUi(inst),
    });

    // The app sets the textarea's value when it opens a canvas or receives a change: follow it.
    Object.defineProperty(ta, 'value', {
      configurable: true,
      get() { return nativeValue.get.call(this); },
      set(next) {
        nativeValue.set.call(this, next);
        if (inst.showing && next !== inst.lastWritten) load(inst, next);
      },
    });

    wireToolbar(inst);
    wireEditorDom(inst);
    wireFloating(inst);
    canvasToolbars.push({ sync: () => refreshUi(inst) });
    return inst;
  }

  function load(inst, markdown) {
    inst.loading = true;
    try {
      inst.editor.commands.setContent(markdown || '', { contentType: 'markdown', emitUpdate: false });
    } finally {
      inst.loading = false;
    }
    inst.lastWritten = markdown || '';
    refreshUi(inst);
  }

  // The page changed: write the Markdown into the textarea and let autosave see an `input`.
  function onEdited(inst) {
    if (inst.loading || !canEdit(inst)) return;
    const markdown = ITAEditor.getCanvasMarkdown(inst.editor);
    if (markdown === inst.lastWritten) return;
    inst.lastWritten = markdown;
    nativeValue.set.call(inst.ta, markdown);
    inst.ta.dispatchEvent(new Event('input', { bubbles: true }));
    refreshUi(inst);
  }

  const canEdit = (inst) => Boolean(canvasViews[inst.which].canEdit);

  function refreshUi(inst) {
    if (!inst.editor || !inst.showing) return;
    const editor = inst.editor;
    const editable = canEdit(inst);
    inst.toolbar.hidden = !(editable && canvasToolbarEnabled());
    inst.contextual.hidden = true;
    inst.strip.hidden = !(editable && editor.isEmpty);
    if (editable) {
      for (const tool of TOOLS) {
        if (tool.sep) continue;
        const button = inst.toolbar.querySelector(`[data-tool="${tool.id}"]`);
        if (button && tool.active) button.classList.toggle('active', Boolean(tool.active(editor)));
      }
      const inCallout = editor.isActive('callout');
      inst.contextual.hidden = !(canvasToolbarEnabled() && inCallout);
      inst.calloutBar.hidden = !inCallout;
      if (inCallout) {
        const current = editor.getAttributes('callout').type;
        inst.calloutBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.calloutType === current));
      }
    }
    updateSlash(inst);
    updateFloating(inst);
  }

  // ---- floating bars for pictures and tables -------------------------------------------------

  function placeFloat(inst, bar, target) {
    if (!target) { bar.hidden = true; return; }
    bar.hidden = false;
    const scrollRect = inst.scroll.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const top = rect.top - scrollRect.top + inst.scroll.scrollTop - bar.offsetHeight - 8;
    bar.style.top = `${Math.max(0, top)}px`;
    bar.style.left = `${Math.max(0, rect.left - scrollRect.left + inst.scroll.scrollLeft)}px`;
  }

  function updateFloating(inst) {
    const editor = inst.editor;
    const editable = canEdit(inst);
    const { selection } = editor.state;
    let imageTarget = null;
    let tableTarget = null;
    if (editable && selection.node && selection.node.type.name === 'image') {
      const figure = editor.view.nodeDOM(selection.from);
      imageTarget = figure && figure.querySelector ? figure.querySelector('.cw-image-frame') : null;
    } else if (editable && editor.isActive('table')) {
      const at = editor.view.domAtPos(selection.from).node;
      const table = (at.nodeType === 1 ? at : at.parentElement).closest('table');
      tableTarget = table ? (table.closest('.tableWrapper') || table) : null;
    }
    placeFloat(inst, inst.imageBar, imageTarget);
    placeFloat(inst, inst.tableBar, tableTarget);
    if (!imageTarget) { inst.imageBar.querySelector('.cw-alt-form').hidden = true; closeMenus(inst.imageBar); }
    if (!tableTarget) closeMenus(inst.tableBar);
    if (imageTarget) {
      const attrs = editor.getAttributes('image');
      inst.imageBar.querySelectorAll('[data-act^="width:"]').forEach((b) => b.classList.toggle('active', Number(b.dataset.act.slice(6)) === (attrs.width || 100)));
      inst.imageBar.querySelectorAll('[data-act^="align:"]').forEach((b) => b.classList.toggle('active', b.dataset.act.slice(6) === (attrs.align || 'left')));
    }
  }

  // The table the cursor is in: { node, start (inside it), before (its position) }.
  function tableInfo(inst) {
    const { $from } = inst.editor.state.selection;
    let depth = $from.depth;
    while (depth > 0 && $from.node(depth).type.name !== 'table') depth -= 1;
    return depth > 0 ? { node: $from.node(depth), start: $from.start(depth), before: $from.before(depth) } : null;
  }

  // Give every column a width in px (an array), or clear them all (null) so the columns share the page equally.
  function setColumnWidths(inst, widths) {
    const info = tableInfo(inst);
    if (!info) return;
    const { state, view } = inst.editor;
    const tr = state.tr;
    info.node.forEach((row, rowOffset) => {
      row.forEach((cell, cellOffset, index) => {
        const width = widths && widths[index] ? [Math.round(widths[index])] : null;
        tr.setNodeMarkup(info.start + rowOffset + 1 + cellOffset, undefined, { ...cell.attrs, colwidth: width });
      });
    });
    view.dispatch(tr);
  }

  // Measure how wide each column wants to be (its longest line, no wrapping), then fit that to the page.
  function autoFitColumns(inst) {
    const info = tableInfo(inst);
    if (!info) return;
    const dom = inst.editor.view.nodeDOM(info.before);
    const table = dom && (dom.matches && dom.matches('table') ? dom : dom.querySelector('table'));
    if (!table) return;
    const probe = make('div', 'cw-editor cw-measure');
    const holder = make('div', 'ProseMirror');
    const copy = table.cloneNode(true);
    copy.querySelectorAll('colgroup').forEach((el) => el.remove());
    copy.removeAttribute('style');
    holder.appendChild(copy);
    probe.appendChild(holder);
    inst.scroll.appendChild(probe);
    const natural = Array.from(copy.querySelector('tr').children).map((cell) => cell.getBoundingClientRect().width);
    probe.remove();
    setColumnWidths(inst, ITAEditor.fitColumnWidths(natural, inst.editor.view.dom.clientWidth));
  }

  // Set the alignment of every cell in the column the cursor is in.
  function setColumnAlign(inst, align) {
    const { state, view } = inst.editor;
    const { $from } = state.selection;
    let depth = $from.depth;
    while (depth > 0 && !['tableCell', 'tableHeader'].includes($from.node(depth).type.name)) depth -= 1;
    if (depth < 2) return;
    const column = $from.index(depth - 1);
    const table = $from.node(depth - 2);
    const tableStart = $from.start(depth - 2);
    const tr = state.tr;
    table.forEach((row, rowOffset) => {
      row.forEach((cell, cellOffset, index) => {
        if (index === column) tr.setNodeMarkup(tableStart + rowOffset + 1 + cellOffset, undefined, { ...cell.attrs, align });
      });
    });
    view.dispatch(tr);
  }

  function wireFloating(inst) {
    const editor = inst.editor;
    for (const bar of [inst.imageBar, inst.tableBar]) {
      bar.addEventListener('mousedown', (event) => { if (!event.target.closest('input')) event.preventDefault(); });
    }
    // open and close the dropdown menus of both bars
    for (const bar of [inst.imageBar, inst.tableBar]) {
      bar.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-menu-toggle]');
        if (!toggle) return;
        const menu = toggle.nextElementSibling;
        const open = menu.hidden;
        closeMenus(bar);
        menu.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
    document.addEventListener('mousedown', (event) => {
      if (event.target.closest && event.target.closest('.cw-menu-wrap')) return;
      closeMenus(inst.imageBar);
      closeMenus(inst.tableBar);
    });

    inst.imageBar.addEventListener('click', (event) => {
      const item = event.target.closest('[data-act]');
      if (!item) return;
      closeMenus(inst.imageBar);
      const chain = editor.chain().focus();
      const act = item.dataset.act;
      if (act.startsWith('width:')) { const width = Number(act.slice(6)); chain.updateAttributes('image', { width: width >= 100 ? null : width }).run(); return; }
      if (act.startsWith('align:')) { chain.updateAttributes('image', { align: act.slice(6) }).run(); return; }
      if (act === 'delete') { chain.deleteSelection().run(); return; }
      if (act === 'replace') {
        pickCanvasImage(() => canvasViews[inst.which].id(), ({ fileId }) => editor.chain().focus().updateAttributes('image', { src: `file:${fileId}` }).run());
        return;
      }
      if (act === 'alt') {
        const form = inst.imageBar.querySelector('.cw-alt-form');
        form.hidden = !form.hidden;
        if (!form.hidden) { const input = form.querySelector('input'); input.value = editor.getAttributes('image').alt || ''; input.focus(); }
      }
    });
    inst.imageBar.querySelector('.cw-alt-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const alt = event.currentTarget.querySelector('input').value.trim();
      event.currentTarget.hidden = true;
      editor.chain().focus().updateAttributes('image', { alt }).run();
    });

    const TABLE_ACTS = {
      rowBefore: (c) => c.addRowBefore(), rowAfter: (c) => c.addRowAfter(), rowDelete: (c) => c.deleteRow(),
      colBefore: (c) => c.addColumnBefore(), colAfter: (c) => c.addColumnAfter(), colDelete: (c) => c.deleteColumn(),
      header: (c) => c.toggleHeaderRow(), tableDelete: (c) => c.deleteTable(),
    };
    inst.tableBar.addEventListener('click', (event) => {
      const item = event.target.closest('[data-act]');
      if (!item) return;
      closeMenus(inst.tableBar);
      const act = item.dataset.act;
      if (act.startsWith('align')) { setColumnAlign(inst, act.slice(5).toLowerCase()); return; }
      if (act === 'equalize') { setColumnWidths(inst, null); return; }
      if (act === 'autofit') { autoFitColumns(inst); return; }
      const run = TABLE_ACTS[act];
      if (run) run(editor.chain().focus()).run();
    });

    // Dragging a column border may not make the table wider than the page: past that point the drag is
    // held at the page edge (the editor's own handler sees a mouse that stops there).
    let limit = null;
    window.addEventListener('mousedown', (event) => {
      limit = null;
      if (!inst.showing || !editor.view.dom.classList.contains('resize-cursor') || !editor.view.dom.contains(event.target)) return;
      const table = event.target.closest('table');
      if (!table) return;
      limit = event.clientX + Math.max(0, editor.view.dom.clientWidth - table.getBoundingClientRect().width);
    }, true);
    for (const type of ['mousemove', 'mouseup']) {
      window.addEventListener(type, (event) => {
        if (limit === null || event.cwReplay) return;
        if (type === 'mouseup') setTimeout(() => { limit = null; }, 0);
        if (event.clientX <= limit) return;
        event.stopImmediatePropagation();
        const held = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: limit, clientY: event.clientY, buttons: event.buttons, view: window });
        held.cwReplay = true;
        (event.target || window).dispatchEvent(held);
      }, true);
    }

    // "+" at the right and bottom edge of the table under the pointer adds a column or a row
    const addAt = (cellSelector, command) => {
      const table = inst.hoverTable;
      const cell = table && table.querySelector(cellSelector);
      if (!cell) return;
      const pos = editor.view.posAtDOM(cell, 0);
      command(editor.chain().focus().setTextSelection(pos)).run();
    };
    inst.addCol.addEventListener('mousedown', (event) => event.preventDefault());
    inst.addRow.addEventListener('mousedown', (event) => event.preventDefault());
    inst.addCol.addEventListener('click', () => addAt('tr:last-child > :last-child', (c) => c.addColumnAfter()));
    inst.addRow.addEventListener('click', () => addAt('tr:last-child > :first-child', (c) => c.addRowAfter()));

    // drag a block by its handle
    inst.grip.addEventListener('dragstart', (event) => {
      if (!inst.hoverBlock) { event.preventDefault(); return; }
      ITAEditor.startBlockDrag(editor, inst.hoverBlock, event);
    });
    inst.grip.addEventListener('dragend', () => { inst.grip.hidden = true; });

    // paste a picture, or drop a picture file onto the page
    const uploadFiles = async (files, pos) => {
      const images = files.filter((file) => /^image\//.test(file.type || ''));
      for (const file of images) {
        const uploaded = await uploadCanvasImage(canvasViews[inst.which].id(), file);
        if (!uploaded) continue;
        if (typeof pos === 'number') editor.commands.setTextSelection(Math.min(pos, editor.state.doc.content.size));
        insertPicture(inst, uploaded.fileId, uploaded.name);
      }
    };
    const dom = editor.view.dom;
    dom.addEventListener('paste', (event) => {
      const files = Array.from((event.clipboardData && event.clipboardData.files) || []).filter((f) => /^image\//.test(f.type || ''));
      if (!files.length || !canEdit(inst)) return;
      event.preventDefault();
      event.stopPropagation();
      uploadFiles(files);
    }, true);
    dom.addEventListener('drop', (event) => {
      const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []).filter((f) => /^image\//.test(f.type || ''));
      if (!files.length) return; // a block being moved: the editor handles it
      event.preventDefault();
      event.stopPropagation();
      if (!canEdit(inst)) return;
      const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      uploadFiles(files, at ? at.pos : undefined);
    }, true);
  }

  // ---- toolbar -------------------------------------------------------------------------------

  function openLink(inst, open) {
    if (!canEdit(inst)) return;
    const show = open === undefined ? inst.linkForm.hidden : open;
    inst.linkForm.hidden = !show;
    if (show) {
      const input = inst.linkForm.querySelector('input');
      input.value = inst.editor.getAttributes('link').href || '';
      input.focus();
      input.select();
    } else {
      inst.editor.commands.focus();
    }
  }

  function normalizeLink(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^(https?:\/\/|mailto:)/i.test(text)) return text;
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null; // javascript:, data: and the like
    return `https://${text}`;
  }

  function insertPicture(inst, fileId, name) {
    const alt = String(name || 'image').replace(/\.[A-Za-z0-9]+$/, '').replace(/[\[\]()\n]/g, ' ').trim().slice(0, 80) || 'image';
    inst.editor.chain().focus().insertContent({ type: 'image', attrs: { src: `file:${fileId}`, alt } }).run();
  }

  function wireToolbar(inst) {
    const handle = (event) => {
      const button = event.target.closest('button[data-tool]');
      if (!button) return;
      const editor = inst.editor;
      const id = button.dataset.tool;
      if (id === 'link') { openLink(inst); return; }
      if (id === 'image') {
        pickCanvasImage(() => canvasViews[inst.which].id(), ({ fileId, name }) => insertPicture(inst, fileId, name));
        return;
      }
      if (button.dataset.calloutType) {
        editor.chain().focus().updateAttributes('callout', { type: button.dataset.calloutType }).run();
        return;
      }
      const tool = TOOLS.find((t) => t.id === id) || TABLE_TOOLS.find((t) => t.id === id);
      if (tool && tool.run) tool.run(editor.chain().focus()).run();
    };
    // keep the selection in the page while a button is pressed
    [inst.toolbar, inst.contextual].forEach((bar) => {
      bar.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
      bar.addEventListener('click', handle);
    });
    inst.linkForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const href = normalizeLink(inst.linkForm.querySelector('input').value);
      if (!href) { canvasNotice('Enter a web address (http, https or mailto).', 'error'); return; }
      const editor = inst.editor;
      if (editor.state.selection.empty && !editor.isActive('link')) {
        editor.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
      } else {
        editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
      }
      openLink(inst, false);
    });
    inst.linkForm.addEventListener('click', (event) => {
      if (!event.target.closest('[data-link-remove]')) return;
      inst.editor.chain().focus().extendMarkRange('link').unsetLink().run();
      openLink(inst, false);
    });
    inst.linkForm.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); openLink(inst, false); } });
    inst.strip.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
    inst.strip.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-template]');
      const tpl = button && CANVAS_TEMPLATES.find((t) => t.id === button.dataset.template);
      if (!tpl || !inst.editor.isEmpty) return;
      inst.editor.commands.setContent(tpl.content, { contentType: 'markdown', emitUpdate: true });
      inst.editor.commands.focus('end');
    });
  }

  // ---- slash menu ----------------------------------------------------------------------------

  function closeSlash(inst) {
    if (inst.menu) inst.menu.el.remove();
    inst.menu = null;
  }

  // The text before the cursor in a plain paragraph: "/" then a command word.
  function slashContext(inst) {
    const { selection } = inst.editor.state;
    if (!selection.empty || !canEdit(inst)) return null;
    const { $from } = selection;
    if ($from.parent.type.name !== 'paragraph') return null;
    const before = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
    const match = /^\/([a-z0-9]*)$/i.exec(before);
    return match ? { query: match[1], from: $from.start(), to: selection.from } : null;
  }

  function renderSlash(inst) {
    const menu = inst.menu;
    if (!menu) return;
    menu.el.innerHTML = menu.items.map((item, i) => `
      <button type="button" class="slash-item${i === menu.active ? ' active' : ''}" role="option" aria-selected="${i === menu.active}" data-slash="${item.id}">
        <span class="slash-label">${item.label}</span>
        <span class="slash-hint">${item.hint}</span>
        <span class="slash-key">/${item.keys[0]}</span>
      </button>`).join('');
    const coords = inst.editor.view.coordsAtPos(inst.editor.state.selection.from);
    const height = menu.el.offsetHeight;
    const width = menu.el.offsetWidth;
    menu.el.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - width - 8))}px`;
    let top = coords.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, coords.top - height - 6);
    menu.el.style.top = `${top}px`;
    const current = menu.el.querySelector('.slash-item.active');
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  function updateSlash(inst) {
    const context = slashContext(inst);
    if (!context) { closeSlash(inst); return; }
    const items = filterSlashItems(context.query);
    if (!items.length) { closeSlash(inst); return; }
    if (!inst.menu) {
      inst.menu = { el: make('div', 'slash-menu', { role: 'listbox', 'aria-label': 'Insert a block' }), items, active: 0, context };
      document.body.appendChild(inst.menu.el);
    } else if (inst.menu.query !== context.query) {
      inst.menu.active = 0;
    }
    inst.menu.items = items;
    inst.menu.query = context.query;
    inst.menu.context = context;
    renderSlash(inst);
  }

  // Replace the "/command" text with the block, then put any text typed after the command inside it.
  function runSlash(inst, item, from, to, text) {
    closeSlash(inst);
    const chain = inst.editor.chain().focus().deleteRange({ from, to });
    if (item.image) {
      chain.run();
      pickCanvasImage(() => canvasViews[inst.which].id(), ({ fileId, name }) => insertPicture(inst, fileId, name));
      return;
    }
    const run = SLASH_RUN[item.id];
    if (!run) { chain.run(); return; }
    run(chain);
    if (text && TEXT_ITEMS.has(item.id)) chain.insertContent(text);
    chain.run();
  }

  // ---- the page itself -----------------------------------------------------------------------

  function wireEditorDom(inst) {
    const dom = inst.editor.view.dom;
    dom.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (inst.menu) {
        const menu = inst.menu;
        if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); menu.active = (menu.active + 1) % menu.items.length; renderSlash(inst); return; }
        if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); menu.active = (menu.active - 1 + menu.items.length) % menu.items.length; renderSlash(inst); return; }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          runSlash(inst, menu.items[menu.active], menu.context.from, menu.context.to, '');
          return;
        }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSlash(inst); return; }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopPropagation();
        openLink(inst, true);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && canEdit(inst)) {
        // "/h1 My title" typed in full, then Enter
        const { selection } = inst.editor.state;
        const { $from } = selection;
        if (selection.empty && $from.parent.type.name === 'paragraph' && $from.parentOffset === $from.parent.content.size) {
          const parsed = parseSlashLine($from.parent.textContent);
          if (parsed && parsed.text && TEXT_ITEMS.has(parsed.item.id)) {
            event.preventDefault();
            event.stopPropagation();
            runSlash(inst, parsed.item, $from.start(), selection.from, parsed.text);
          }
        }
      }
    }, true);

    dom.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link) return;
      if (!canEdit(inst) || event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (/^(https?:|mailto:)/i.test(link.href)) window.open(link.href, '_blank', 'noopener');
      }
    });
    dom.addEventListener('blur', () => setTimeout(() => closeSlash(inst), 150));

    // pick from the slash menu with the mouse
    document.addEventListener('mousedown', (event) => {
      const button = event.target.closest ? event.target.closest('.slash-item') : null;
      if (!button || !inst.menu || !inst.menu.el.contains(button)) return;
      event.preventDefault();
      const item = slashItemById(button.dataset.slash);
      if (item) runSlash(inst, item, inst.menu.context.from, inst.menu.context.to, '');
    });

    // comment bubble, drag grip and table "+" handles follow the pointer
    inst.scroll.addEventListener('mousemove', (event) => {
      if (!canEdit(inst)) { inst.bubble.hidden = true; inst.grip.hidden = true; inst.addCol.hidden = true; inst.addRow.hidden = true; return; }
      const onTool = event.target.closest && event.target.closest('.cw-grip, .cw-bubble, .cw-add-handle, .cw-float');
      if (onTool) return;
      const scrollRect = inst.scroll.getBoundingClientRect();
      const relTop = (el) => el.getBoundingClientRect().top - scrollRect.top + inst.scroll.scrollTop;
      const block = event.target.closest ? event.target.closest('.ProseMirror > *') : null;
      if (block && inst.mount.contains(block)) {
        inst.hoverBlock = block;
        inst.grip.style.top = `${Math.max(0, relTop(block))}px`;
        inst.grip.hidden = false;
        const text = (block.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (text) {
          inst.bubble.style.top = `${Math.max(0, relTop(block))}px`;
          inst.bubble.dataset.ccAnchor = text;
          inst.bubble.hidden = false;
        } else {
          inst.bubble.hidden = true;
        }
      }
      const table = event.target.closest ? event.target.closest('.ProseMirror table') : null;
      if (table) {
        inst.hoverTable = table;
        const rect = (table.closest('.tableWrapper') || table).getBoundingClientRect();
        const tableRect = table.getBoundingClientRect();
        inst.addCol.style.top = `${relTop(table) + Math.min(tableRect.height, rect.height) / 2 - 11}px`;
        inst.addCol.style.left = `${tableRect.right - scrollRect.left + inst.scroll.scrollLeft + 6}px`;
        inst.addRow.style.top = `${relTop(table) + tableRect.height + 6}px`;
        inst.addRow.style.left = `${tableRect.left - scrollRect.left + inst.scroll.scrollLeft + tableRect.width / 2 - 11}px`;
        inst.addCol.hidden = false;
        inst.addRow.hidden = false;
      } else if (block) {
        inst.addCol.hidden = true;
        inst.addRow.hidden = true;
      }
    });
    inst.scroll.addEventListener('mouseleave', () => { inst.bubble.hidden = true; inst.grip.hidden = true; inst.addCol.hidden = true; inst.addRow.hidden = true; });
  }

  function show(which) {
    const inst = ensure(which);
    const view = canvasViews[which];
    inst.showing = true;
    load(inst, inst.ta.value);
    inst.editor.setEditable(Boolean(view.canEdit));
    inst.container.hidden = false;
    inst.ta.hidden = true;
    inst.ta.dataset.richActive = view.canEdit ? '1' : '0';
    refreshUi(inst);
    if (view.canEdit && inst.editor.isEmpty) inst.editor.commands.focus('start');
  }

  function hide(which) {
    const inst = instances[which];
    if (!inst) return;
    inst.showing = false;
    closeSlash(inst);
    inst.container.hidden = true;
    inst.ta.dataset.richActive = '0';
  }

  return { show, hide };
})();
