// IT Avenue Workspace - Export a canvas as PDF, Word (.docx) or Markdown.
//
// Loaded after canvas-wysiwyg.js. The page gathers the content (the editor's document, and each picture
// fetched with the signed-in request and converted to PNG); the main process builds the file and asks
// where to save it (main.js, export/). Only the desktop app can save files, so the menu is hidden elsewhere.

const canvasExport = (() => {
  const FORMATS = [
    ['pdf', 'PDF document (.pdf)'],
    ['docx', 'Word document (.docx)'],
    ['md', 'Markdown file (.md)'],
  ];
  const MAX_PICTURE_WIDTH = 1600;

  const bytesToBase64 = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  // Every canvas picture used by the document, as PNG: { id: { base64, width, height } }.
  async function fetchPictures(ids) {
    const pictures = {};
    for (const id of ids) {
      try {
        const res = await fetch(`${API_BASE}/api/files/${id}/download`, { headers: { Authorization: `Bearer ${state.token}` } });
        if (!res.ok) continue;
        const bitmap = await createImageBitmap(await res.blob());
        const scale = Math.min(1, MAX_PICTURE_WIDTH / bitmap.width);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
        const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        pictures[id] = { base64: bytesToBase64(png), width, height };
      } catch (err) {
        console.error('Export: picture skipped', id, err);
      }
    }
    return pictures;
  }

  function pictureIds(node, found = new Set()) {
    if (node && node.type === 'image') {
      const match = /^file:(\d+)$/.exec((node.attrs && node.attrs.src) || '');
      if (match) found.add(match[1]);
    }
    (node && node.content ? node.content : []).forEach((child) => pictureIds(child, found));
    return found;
  }

  // The editor's HTML with each picture inlined (the printing window has no network), keeping size and alignment.
  function inlinePictures(html, pictures) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    doc.querySelectorAll('img[data-cv-file]').forEach((img) => {
      const picture = pictures[img.getAttribute('data-cv-file')];
      if (!picture) {
        const note = doc.createElement('p');
        note.textContent = `[${img.getAttribute('alt') || 'picture'}]`;
        img.replaceWith(note);
        return;
      }
      const wrap = doc.createElement('div');
      wrap.className = 'pic';
      wrap.setAttribute('data-align', img.getAttribute('data-align') || 'left');
      const copy = doc.createElement('img');
      copy.src = `data:image/png;base64,${picture.base64}`;
      copy.alt = img.getAttribute('alt') || '';
      const percent = Number(img.getAttribute('data-width'));
      if (percent) copy.style.width = `${percent}%`;
      wrap.appendChild(copy);
      img.replaceWith(wrap);
    });
    return doc.body.innerHTML;
  }

  async function run(which, format) {
    const view = canvasViews[which];
    const title = (view.title().value || '').trim() || 'Untitled canvas';
    try {
      let request;
      if (format === 'md') {
        view.flush();
        request = { format, title, markdown: view.editor().value };
      } else {
        showToast('Preparing the export…', 'info');
        const { json, html } = canvasWysiwyg.exportData(which);
        const pictures = await fetchPictures(Array.from(pictureIds(json)));
        request = format === 'docx'
          ? { format, title, doc: json, images: pictures }
          : { format, title, html: inlinePictures(html, pictures) };
      }
      const result = await window.electronAPI.exportCanvas(request);
      if (result && result.path) showToast(`Saved to ${result.path}`, 'success');
    } catch (err) {
      console.error('Export error:', err);
      showToast((err && err.message) || 'Could not export the canvas.', 'error');
    }
  }

  function install() {
    if (!(window.electronAPI && window.electronAPI.exportCanvas)) return; // only the desktop app can save files
    for (const [which, historyId] of [['standalone', 'btn-canvas2-history'], ['sheet', 'btn-canvas-sheet-history']]) {
      const anchor = document.getElementById(historyId);
      if (!anchor || anchor.parentNode.querySelector('.cw-export-wrap')) continue;
      const wrap = document.createElement('span');
      wrap.className = 'cw-menu-wrap cw-export-wrap';
      wrap.innerHTML = `<button type="button" class="btn canvas-mode-btn cw-menu-toggle" data-export-toggle title="Save this canvas as a file" aria-haspopup="true" aria-expanded="false">Export <span aria-hidden="true">▾</span></button>
        <div class="cw-menu cw-menu-right" role="menu" hidden>${FORMATS.map(([id, label]) => `<button type="button" role="menuitem" class="cw-menu-item" data-export="${id}" data-export-which="${which}">${label}</button>`).join('')}</div>`;
      anchor.parentNode.insertBefore(wrap, anchor);
    }
  }

  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-export-toggle]');
    const item = event.target.closest('[data-export]');
    document.querySelectorAll('.cw-export-wrap .cw-menu').forEach((menu) => {
      const mine = menu.parentNode.contains(event.target);
      menu.hidden = !(toggle && mine && menu.hidden);
      menu.parentNode.querySelector('[data-export-toggle]').setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    });
    if (item) run(item.dataset.exportWhich, item.dataset.export);
  });

  install();
  return { run, pictureIds, inlinePictures, install };
})();
