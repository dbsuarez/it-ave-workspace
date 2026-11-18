// IT Avenue Workspace - drawings: the picture on a drawing's card in a conversation.
//
// An editor's client saves a small PNG of the drawing a few seconds after the last change (and when the drawing is closed);
// the server keeps it with the drawing. Cards show it instead of a title and button. The picture is fetched with the person's
// sign-in (an <img> cannot send it), turned into a local object URL, and remembered per drawing and version.

const DRAWING_PREVIEW_DELAY_MS = 5000;
const DRAWING_PREVIEW_SIZES = [640, 320]; // the longest side; the smaller one is tried if the first is over the size limit
const DRAWING_PREVIEW_MAX_BYTES = 280 * 1024; // the server takes at most 300 KB

const drawingPreviewUrls = new Map();
const drawingPreviewState = { timer: null };

const drawingPreviewKey = (id, version) => `${Number(id)}:${Number(version)}`;

// Whether this client should save a preview right now.
function drawingPreviewWanted({ role, draft, online, shapes }) {
  return role === 'editor' && !draft && Boolean(online) && Number(shapes) > 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { drawingPreviewWanted, drawingPreviewKey };
}

// ---- everything below touches the page and the network; it is exercised in the browser, not in node ----

async function fillDrawingPreview(image) {
  const id = Number(image.dataset.drawingPreview);
  const version = Number(image.dataset.previewVersion);
  const key = drawingPreviewKey(id, version);
  if (image.dataset.previewLoaded === key) return;
  let url = drawingPreviewUrls.get(key);
  if (!url) {
    try {
      const response = await api(`/api/drawings/${id}/preview`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      url = URL.createObjectURL(await response.blob());
      drawingPreviewUrls.set(key, url);
    } catch (err) {
      image.closest('.drawing-preview')?.classList.add('failed');
      return;
    }
  }
  image.dataset.previewLoaded = key;
  image.src = url;
}

function fillDrawingPreviewsIn(root) {
  if (!root || !root.querySelectorAll) return;
  if (root.matches && root.matches('img[data-drawing-preview]')) fillDrawingPreview(root);
  root.querySelectorAll('img[data-drawing-preview]').forEach(fillDrawingPreview);
}

// Cards appear whenever messages are drawn; fill in their pictures as they do.
function installDrawingPreviews() {
  if (typeof MutationObserver !== 'function') return;
  new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach((node) => { if (node.nodeType === 1) fillDrawingPreviewsIn(node); });
  }).observe(document.body, { childList: true, subtree: true });
}

// A new preview exists: update every card of that drawing that is on screen.
function refreshDrawingCards(drawingId, version) {
  for (const card of document.querySelectorAll(`.drawing-card[data-drawing-card="${Number(drawingId)}"]`)) {
    const image = card.querySelector('img[data-drawing-preview]');
    if (image) {
      image.dataset.previewVersion = String(version);
      fillDrawingPreview(image);
    } else {
      const title = card.querySelector('.drawing-card-title')?.textContent || '';
      const holder = document.createElement('div');
      holder.innerHTML = drawingCardHtml({ id: drawingId, title, previewVersion: version });
      card.replaceWith(holder.firstElementChild);
    }
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Saves a preview of the open drawing now (if this client should).
async function saveDrawingPreviewNow() {
  clearTimeout(drawingPreviewState.timer);
  drawingPreviewState.timer = null;
  const open = drawingsState.open;
  const handle = drawingsState.handle;
  if (!open || !handle) return;
  try {
    const shapes = handle.getElements().filter((shape) => !shape.isDeleted).length;
    if (!drawingPreviewWanted({ role: open.drawing.role, draft: drawingIsDraft(open.id), online: Boolean(state.socket && state.socket.connected), shapes })) return;
    let blob = null;
    for (const size of DRAWING_PREVIEW_SIZES) {
      blob = await handle.exportPng({ maxWidthOrHeight: size });
      if (blob.size <= DRAWING_PREVIEW_MAX_BYTES) break;
    }
    if (!blob || blob.size > DRAWING_PREVIEW_MAX_BYTES) return;
    const saved = await drawingJson(`/api/drawings/${open.id}/preview`, { method: 'PUT', body: JSON.stringify({ dataBase64: await blobToBase64(blob) }) });
    if (drawingsState.open && drawingsState.open.id === open.id) drawingsState.open.drawing = { ...drawingsState.open.drawing, previewVersion: saved.previewVersion };
    refreshDrawingCards(open.id, saved.previewVersion);
  } catch (err) { console.warn('Could not save the drawing preview:', err.message || err); }
}

function scheduleDrawingPreview(delay = DRAWING_PREVIEW_DELAY_MS) {
  clearTimeout(drawingPreviewState.timer);
  drawingPreviewState.timer = setTimeout(saveDrawingPreviewNow, delay);
}

// When the drawing is closed a preview that is still waiting is saved at once.
async function flushDrawingPreview() {
  if (drawingPreviewState.timer !== null) await saveDrawingPreviewNow();
}
