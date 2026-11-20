// IT Avenue Workspace - cover photos: the wide picture at the top of a person's page and of their profile card. Each person sets and removes
// their own (Change cover / Remove cover on their own page); without one the bar shows their avatar colour. The crop maths is cover-crop.js.
// Fetched with the sign-in like profile photos, cached per person and version. Loaded before renderer.js.

const coverUrlCache = new Map(); // "id:version" -> Promise<blob URL | null>

async function userCoverBlob(person) {
  if (!person || !person.coverVersion || person.id === undefined) return null;
  try {
    const res = await fetch(`${API_BASE}/api/users/${person.id}/cover?v=${person.coverVersion}`, { headers: { Authorization: `Bearer ${state.token}` } });
    return res.ok ? await res.blob() : null;
  } catch (err) {
    return null;
  }
}

function userCoverUrl(person) {
  if (!person || !person.coverVersion || person.id === undefined) return Promise.resolve(null);
  const key = `${person.id}:${person.coverVersion}`;
  if (!coverUrlCache.has(key)) coverUrlCache.set(key, userCoverBlob(person).then((blob) => (blob ? URL.createObjectURL(blob) : null)));
  return coverUrlCache.get(key);
}

// Show the person's cover on a banner element (it keeps its colour underneath until the picture is there, and when there is none).
async function paintCover(element, person) {
  if (!element) return;
  const url = await userCoverUrl(person);
  if (!url) return;
  element.style.backgroundImage = `url("${url}")`;
  element.style.backgroundSize = 'cover';
  element.style.backgroundPosition = 'center';
  element.classList.add('has-cover');
}

// The chosen picture behind a wide window: drag to move, scroll or the slider to zoom. Resolves with a 1500x300 JPEG of what is in the window,
// or null when they cancel.
function openCoverCropper(file) {
  return new Promise((resolve) => {
    const VIEW_W = 640;
    const VIEW_H = Math.round(VIEW_W * COVER_HEIGHT / COVER_WIDTH);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); showToast('That file could not be read as a picture.', 'error'); resolve(null); };
    img.onload = () => {
      let crop = coverInitialState(img.naturalWidth, img.naturalHeight, VIEW_W, VIEW_H);
      const overlay = document.createElement('div');
      overlay.className = 'photo-crop-overlay';
      overlay.innerHTML = `
        <form class="photo-crop-dialog cover-crop-dialog" role="dialog" aria-modal="true" aria-label="Position your cover photo">
          <h3>Position your cover photo</h3>
          <p class="photo-crop-hint">Drag the picture to choose the part to show. Scroll or use the slider to zoom. A wide picture works best (about 1500 x 300).</p>
          <div class="photo-crop-window cover-crop-window" style="width:${VIEW_W}px;height:${VIEW_H}px;">
            <img alt="" draggable="false">
          </div>
          <div class="photo-crop-zoom"><span aria-hidden="true">&minus;</span><input type="range" min="1" max="${COVER_MAX_ZOOM}" step="0.01" value="1" aria-label="Zoom"><span aria-hidden="true">+</span></div>
          <div class="photo-crop-actions">
            <button type="button" class="btn" data-cover-reset>Reset</button>
            <span class="photo-crop-spacer"></span>
            <button type="button" class="btn" data-cover-cancel>Cancel</button>
            <button type="submit" class="btn primary">Use this cover</button>
          </div>
        </form>`;
      document.body.appendChild(overlay);
      const view = overlay.querySelector('.cover-crop-window');
      const shown = overlay.querySelector('img');
      const slider = overlay.querySelector('input[type="range"]');
      shown.src = url;
      const paint = () => {
        const scale = coverBaseScale(crop) * crop.zoom;
        shown.style.width = `${crop.w * scale}px`;
        shown.style.height = `${crop.h * scale}px`;
        shown.style.transform = `translate(${crop.ox}px, ${crop.oy}px)`;
        slider.value = String(crop.zoom);
      };
      paint();
      let drag = null;
      view.addEventListener('pointerdown', (event) => { drag = { x: event.clientX, y: event.clientY }; view.setPointerCapture(event.pointerId); view.classList.add('dragging'); });
      view.addEventListener('pointermove', (event) => {
        if (!drag) return;
        crop = coverMoveBy(crop, event.clientX - drag.x, event.clientY - drag.y);
        drag = { x: event.clientX, y: event.clientY };
        paint();
      });
      const endDrag = () => { drag = null; view.classList.remove('dragging'); };
      view.addEventListener('pointerup', endDrag);
      view.addEventListener('pointercancel', endDrag);
      view.addEventListener('wheel', (event) => {
        event.preventDefault();
        const box = view.getBoundingClientRect();
        crop = coverZoomAbout(crop, crop.zoom * Math.exp(-event.deltaY * 0.0015), event.clientX - box.left, event.clientY - box.top);
        paint();
      }, { passive: false });
      slider.addEventListener('input', () => { crop = coverZoomAbout(crop, Number(slider.value), VIEW_W / 2, VIEW_H / 2); paint(); });
      view.tabIndex = 0;
      view.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 20 : 6;
        const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (moves[event.key]) { crop = coverMoveBy(crop, ...moves[event.key]); paint(); event.preventDefault(); }
        else if (event.key === '+' || event.key === '=') { crop = coverZoomAbout(crop, crop.zoom * 1.1, VIEW_W / 2, VIEW_H / 2); paint(); }
        else if (event.key === '-') { crop = coverZoomAbout(crop, crop.zoom / 1.1, VIEW_W / 2, VIEW_H / 2); paint(); }
      });
      overlay.querySelector('[data-cover-reset]').addEventListener('click', () => { crop = coverInitialState(img.naturalWidth, img.naturalHeight, VIEW_W, VIEW_H); paint(); });
      const finish = (blob) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        URL.revokeObjectURL(url);
        resolve(blob);
      };
      const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); } };
      document.addEventListener('keydown', onKey, true);
      overlay.querySelector('[data-cover-cancel]').addEventListener('click', () => finish(null));
      overlay.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const { sx, sy, sw, sh } = coverSourceRect(crop);
        const canvas = document.createElement('canvas');
        canvas.width = COVER_WIDTH;
        canvas.height = COVER_HEIGHT;
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.fillStyle = '#ffffff'; // a transparent PNG becomes white, not black, in a JPEG
        context.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
        context.drawImage(img, sx, sy, sw, sh, 0, 0, COVER_WIDTH, COVER_HEIGHT);
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.88);
      });
      view.focus();
    };
    img.src = url;
  });
}

async function setOwnCover(file) {
  try {
    const blob = await openCoverCropper(file);
    if (!blob) return; // they cancelled
    const form = new FormData();
    form.append('file', blob, 'cover.jpg');
    const res = await fetch(`${API_BASE}/api/users/me/cover`, { method: 'PUT', headers: { Authorization: `Bearer ${state.token}` }, body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save the cover photo');
    showToast('Cover photo updated.', 'success');
    if (typeof peopleState !== 'undefined' && Number(peopleState.pageId) === Number(state.user.id)) openPersonPage(state.user.id);
  } catch (err) {
    console.error('Set cover error:', err);
    showToast(err.message || 'Could not use that picture.', 'error');
  }
}

async function removeOwnCover() {
  try {
    const res = await api('/api/users/me/cover', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not remove the cover photo');
    showToast('Cover photo removed.', 'success');
    if (typeof peopleState !== 'undefined' && Number(peopleState.pageId) === Number(state.user.id)) openPersonPage(state.user.id);
  } catch (err) {
    showToast(err.message || 'Could not remove the cover photo.', 'error');
  }
}

// "Change cover" opens the file chooser on a hidden input made on demand.
function chooseCoverFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg';
  input.addEventListener('change', () => { const file = input.files && input.files[0]; if (file) setOwnCover(file); });
  input.click();
}
