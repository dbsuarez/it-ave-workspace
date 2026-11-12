// IT Avenue Workspace - thumbnails for picture files (Files view, Saved items).
//
// A file sits behind the sign-in, so its picture is fetched with the token, shrunk in the browser to a small
// thumbnail, and cached for the session. Only thumbnails that scroll into view are loaded, a few at a time, so a
// long list of big pictures does not flood the server. A file that cannot be shown keeps its icon.
// Elements opt in with data-thumb-file="<id>" and data-thumb-mime="<type>"; call hydrateThumbnails(root).

const THUMB_SIZE = 320; // the long side, in pixels (cards show them at about 150 px, so this is sharp on high-density screens)
const THUMB_AT_A_TIME = 2;
const THUMB_TYPES = /^image\/(png|jpe?g|gif|webp|bmp)$/i;

function isThumbnailable(mimeType) {
  return THUMB_TYPES.test(String(mimeType || ''));
}

// The size to draw a picture at so its long side is at most max (never enlarged).
function thumbnailSize(width, height, max = THUMB_SIZE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const thumbnailUrls = new Map(); // file id -> Promise<blob URL | null>
const thumbnailQueue = [];
let thumbnailsRunning = 0;

async function makeThumbnail(fileId) {
  try {
    const res = await fetch(`${API_BASE}/api/files/${fileId}/download`, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const size = thumbnailSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ? URL.createObjectURL(blob) : null;
  } catch (err) {
    return null; // not a picture the browser can read: keep the icon
  }
}

function pumpThumbnails() {
  while (thumbnailsRunning < THUMB_AT_A_TIME && thumbnailQueue.length) {
    const job = thumbnailQueue.shift();
    thumbnailsRunning += 1;
    makeThumbnail(job.fileId).then(job.resolve).finally(() => { thumbnailsRunning -= 1; pumpThumbnails(); });
  }
}

function thumbnailUrl(fileId) {
  if (!thumbnailUrls.has(fileId)) {
    thumbnailUrls.set(fileId, new Promise((resolve) => { thumbnailQueue.push({ fileId, resolve }); pumpThumbnails(); }));
  }
  return thumbnailUrls.get(fileId);
}

let thumbnailObserver = null;

function showThumbnail(element) {
  const fileId = element.dataset.thumbFile;
  thumbnailUrl(fileId).then((url) => {
    if (!url || !element.isConnected) return;
    element.style.backgroundImage = `url("${url}")`;
    element.classList.add('has-thumb');
    element.replaceChildren(); // the icon goes
  });
}

// Start loading the thumbnails inside root as they come into view.
function hydrateThumbnails(root) {
  const scope = root || document;
  const targets = scope.querySelectorAll('[data-thumb-file]:not([data-thumb-started])');
  if (!targets.length) return;
  if (!thumbnailObserver && typeof IntersectionObserver === 'function') {
    thumbnailObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbnailObserver.unobserve(entry.target);
        showThumbnail(entry.target);
      }
    }, { rootMargin: '300px' });
  }
  targets.forEach((element) => {
    if (!isThumbnailable(element.dataset.thumbMime)) return;
    element.dataset.thumbStarted = '1';
    if (thumbnailObserver) thumbnailObserver.observe(element); else showThumbnail(element);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isThumbnailable, thumbnailSize, THUMB_SIZE };
}
