// IT Avenue Workspace - profile photos.
//
// A photo is fetched with the signed-in request (there is no public URL) and shown from a blob URL that is
// cached per person and per version, so a changed photo shows up and an unchanged one is fetched once.
// Setting one: pick a picture, position it in a round window (drag, zoom), and the window's square is cut out and saved
// at 512x512 (features/photo-crop.js), then uploaded (PUT /api/users/me/photo).
//
// Loaded before renderer.js; renderer.js calls paintOwnAvatar / refreshOwnProfile / setupProfilePhoto.

const photoUrlCache = new Map(); // "id:version" -> Promise<blob URL | null>

// The photo as a Blob, or null when the person has none (or it cannot be fetched).
async function userPhotoBlob(person) {
  if (!person || !person.photoVersion || person.id === undefined) return null;
  try {
    const res = await fetch(`${API_BASE}/api/users/${person.id}/photo?v=${person.photoVersion}`, { headers: { Authorization: `Bearer ${state.token}` } });
    return res.ok ? await res.blob() : null;
  } catch (err) {
    return null;
  }
}

// A URL for <img> / background-image, cached; resolves null when there is no photo.
function userPhotoUrl(person) {
  if (!person || !person.photoVersion || person.id === undefined) return Promise.resolve(null);
  const key = `${person.id}:${person.photoVersion}`;
  if (!photoUrlCache.has(key)) {
    photoUrlCache.set(key, userPhotoBlob(person).then((blob) => (blob ? URL.createObjectURL(blob) : null)));
  }
  return photoUrlCache.get(key);
}

// Used by the editor's profile cards (editor-src/canvas-editor.js).
function canvasUserPhoto(person) {
  return userPhotoUrl(person);
}

// Show the person's photo on an avatar element, or their initial on their color.
async function paintAvatar(element, person, fallbackText) {
  if (!element) return;
  const url = await userPhotoUrl(person);
  if (url) {
    element.style.backgroundImage = `url("${url}")`;
    element.style.backgroundSize = 'cover';
    element.style.backgroundPosition = 'center';
    // drop the initial but keep any child element (the presence dot on a list avatar)
    Array.from(element.childNodes).forEach((node) => { if (node.nodeType === 3) node.remove(); });
    element.classList.add('has-photo');
  } else {
    element.style.backgroundImage = '';
    element.classList.remove('has-photo');
    if (fallbackText !== undefined) element.textContent = fallbackText;
  }
}

// ---- one painter for every avatar in the app ----------------------------------------------------
// An avatar element names its person with data-avatar-user (or the older data-user-id on .avatar-mini and
// .read-receipt-avatar). Whenever one appears, or the people list changes, the person's photo replaces the
// colored initial. People without a photo keep the initial.
const AVATAR_SELECTOR = '[data-avatar-user], .avatar-mini[data-user-id], .read-receipt-avatar[data-user-id]';

function personForPhoto(id) {
  if (state.user && Number(state.user.id) === Number(id)) return state.user;
  return (state.users || []).find((user) => Number(user.id) === Number(id)) || null;
}

function paintAvatarElement(element) {
  const id = Number(element.dataset.avatarUser || element.dataset.userId);
  if (!Number.isSafeInteger(id) || id < 1) return;
  const person = personForPhoto(id);
  if (person && !person.photoVersion && element.classList.contains('has-photo')) {
    // their photo was removed: back to the initial on their color
    element.style.backgroundImage = '';
    element.classList.remove('has-photo');
    delete element.dataset.photoPainted;
    element.prepend(document.createTextNode((person.username || '?').charAt(0).toUpperCase()));
    return;
  }
  if (!person || !person.photoVersion) return;
  if (element.dataset.photoPainted === String(person.photoVersion)) return;
  element.dataset.photoPainted = String(person.photoVersion);
  paintAvatar(element, person);
}

function paintAvatarsIn(root) {
  if (root.matches && root.matches(AVATAR_SELECTOR)) paintAvatarElement(root);
  if (root.querySelectorAll) root.querySelectorAll(AVATAR_SELECTOR).forEach(paintAvatarElement);
}

// After the people list loads or someone changes their photo: paint everything on screen again.
function repaintAllAvatars() {
  document.querySelectorAll(AVATAR_SELECTOR).forEach((element) => {
    delete element.dataset.photoPainted;
    paintAvatarElement(element);
  });
  paintOwnAvatar();
}

// Someone (maybe me, on another computer) changed their photo.
function handleUserPhotoUpdated(event) {
  if (!event) return;
  const person = personForPhoto(event.userId);
  if (person) person.photoVersion = event.photoVersion || null;
  repaintAllAvatars();
}

if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
  const pendingAvatarNodes = new Set();
  let avatarPaintScheduled = false;
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => { if (node.nodeType === 1) pendingAvatarNodes.add(node); });
    }
    if (avatarPaintScheduled || pendingAvatarNodes.size === 0) return;
    avatarPaintScheduled = true;
    requestAnimationFrame(() => {
      avatarPaintScheduled = false;
      const nodes = Array.from(pendingAvatarNodes);
      pendingAvatarNodes.clear();
      nodes.forEach(paintAvatarsIn);
    });
  }).observe(document.body, { childList: true, subtree: true });
}

function paintOwnAvatar() {
  if (!state.user) return;
  const initial = (state.user.username || '?').charAt(0).toUpperCase();
  paintAvatar(els.userAvatar, state.user, initial);
}

function paintProfilePhotoPreview() {
  const preview = document.getElementById('profile-photo-preview');
  if (!preview || !state.user) return;
  preview.style.background = state.user.avatarColor || '#6B21A8';
  paintAvatar(preview, state.user, (state.user.username || '?').charAt(0).toUpperCase());
  const remove = document.getElementById('btn-profile-photo-remove');
  if (remove) remove.hidden = !state.user.photoVersion;
}

// The name, email and avatar in the account menu, from state.user (kept current by refreshOwnProfile).
function paintAccountMenu() {
  if (!state.user) return;
  const manage = document.getElementById('user-manage-profile');
  if (manage) manage.hidden = !state.user.isSuperadmin;
  const full = [state.user.firstName, state.user.middleName, state.user.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  if (els.userName) els.userName.textContent = full || state.user.username;
  if (els.userEmail) els.userEmail.textContent = [full ? `@${state.user.username}` : '', state.user.email || ''].filter(Boolean).join(' · ');
  if (els.userAvatar) {
    els.userAvatar.parentElement.style.backgroundColor = state.user.avatarColor || '';
    if (!els.userAvatar.classList.contains('has-photo')) els.userAvatar.textContent = (state.user.username || '?').charAt(0).toUpperCase();
  }
}

// The sign-in response has no job title or photo, and goes stale (HR can change a name or an email); fetch the
// full profile when the app is up, when the account menu opens, and when the server says it changed.
async function refreshOwnProfile() {
  try {
    const res = await api('/api/auth/me');
    const data = await res.json();
    if (!res.ok || !data.user) return;
    // the sign-in answer is a snapshot: take what the account says now (username, email, names, color, title, photo)
    const u = data.user;
    state.user = {
      ...state.user, username: u.username, email: u.email, avatarColor: u.avatarColor, isSuperadmin: u.isSuperadmin,
      firstName: u.firstName || '', middleName: u.middleName || '', lastName: u.lastName || '',
      jobTitle: u.jobTitle || '', photoVersion: u.photoVersion || null, roleColor: u.roleColor || null,
    };
    await electronAPI.storeSet('user', state.user);
    paintAccountMenu();
    paintOwnAvatar();
    // an account the Superadmin created starts with a temporary password: ask for a new one
    if (data.user.mustChangePassword && typeof openAccountModal === 'function') {
      openAccountModal();
      showToast('Please choose your own password.', 'info');
    }
  } catch (err) {
    console.error('Refresh profile error:', err);
  }
}

// Show the chosen picture in a round window so the person can center their face: drag to move, scroll or the slider to
// zoom. Resolves with a 512x512 JPEG of what is in the window, or null when they cancel.
function openPhotoCropper(file) {
  return new Promise((resolve) => {
    const VIEW = 320;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); showToast('That file could not be read as a picture.', 'error'); resolve(null); };
    img.onload = () => {
      let crop = initialState(img.naturalWidth, img.naturalHeight, VIEW);
      const overlay = document.createElement('div');
      overlay.className = 'photo-crop-overlay';
      overlay.innerHTML = `
        <form class="photo-crop-dialog" role="dialog" aria-modal="true" aria-label="Position your photo">
          <h3>Position your photo</h3>
          <p class="photo-crop-hint">Drag the picture so your face is in the middle of the circle. Scroll or use the slider to zoom.</p>
          <div class="photo-crop-window" id="photo-crop-window" style="width:${VIEW}px;height:${VIEW}px;">
            <img id="photo-crop-image" alt="" draggable="false">
            <div class="photo-crop-mask"></div>
            <div class="photo-crop-guides"></div>
          </div>
          <div class="photo-crop-zoom"><span aria-hidden="true">−</span><input id="photo-crop-slider" type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1" aria-label="Zoom"><span aria-hidden="true">+</span></div>
          <div class="photo-crop-actions">
            <button type="button" class="btn" id="photo-crop-reset">Reset</button>
            <span class="photo-crop-spacer"></span>
            <button type="button" class="btn" id="photo-crop-cancel">Cancel</button>
            <button type="submit" class="btn primary">Use this photo</button>
          </div>
        </form>`;
      document.body.appendChild(overlay);
      const view = overlay.querySelector('#photo-crop-window');
      const shown = overlay.querySelector('#photo-crop-image');
      const slider = overlay.querySelector('#photo-crop-slider');
      shown.src = url;

      const paint = () => {
        const scale = scaleOf(crop);
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
        crop = moveBy(crop, event.clientX - drag.x, event.clientY - drag.y);
        drag = { x: event.clientX, y: event.clientY };
        paint();
      });
      const endDrag = () => { drag = null; view.classList.remove('dragging'); };
      view.addEventListener('pointerup', endDrag);
      view.addEventListener('pointercancel', endDrag);
      view.addEventListener('wheel', (event) => {
        event.preventDefault();
        const box = view.getBoundingClientRect();
        crop = zoomAbout(crop, crop.zoom * Math.exp(-event.deltaY * 0.0015), event.clientX - box.left, event.clientY - box.top);
        paint();
      }, { passive: false });
      slider.addEventListener('input', () => { crop = zoomAbout(crop, Number(slider.value), VIEW / 2, VIEW / 2); paint(); });
      // arrow keys nudge the picture, + and - zoom (the window is focusable)
      view.tabIndex = 0;
      view.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 20 : 6;
        const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (moves[event.key]) { crop = moveBy(crop, ...moves[event.key]); paint(); event.preventDefault(); }
        else if (event.key === '+' || event.key === '=') { crop = zoomAbout(crop, crop.zoom * 1.1, VIEW / 2, VIEW / 2); paint(); }
        else if (event.key === '-') { crop = zoomAbout(crop, crop.zoom / 1.1, VIEW / 2, VIEW / 2); paint(); }
      });
      overlay.querySelector('#photo-crop-reset').addEventListener('click', () => { crop = initialState(img.naturalWidth, img.naturalHeight, VIEW); paint(); });

      const finish = (blob) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        URL.revokeObjectURL(url);
        resolve(blob);
      };
      const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); } };
      document.addEventListener('keydown', onKey, true);
      overlay.querySelector('#photo-crop-cancel').addEventListener('click', () => finish(null));
      overlay.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const { sx, sy, size } = sourceRect(crop);
        const canvas = document.createElement('canvas');
        canvas.width = PHOTO_STORE_SIZE;
        canvas.height = PHOTO_STORE_SIZE;
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.fillStyle = '#ffffff'; // a transparent PNG becomes white, not black, in a JPEG
        context.fillRect(0, 0, PHOTO_STORE_SIZE, PHOTO_STORE_SIZE);
        context.drawImage(img, sx, sy, size, size, 0, 0, PHOTO_STORE_SIZE, PHOTO_STORE_SIZE);
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.9);
      });
      view.focus();
    };
    img.src = url;
  });
}

async function setOwnPhoto(file) {
  try {
    const blob = await openPhotoCropper(file);
    if (!blob) return; // they cancelled
    const form = new FormData();
    form.append('file', blob, 'photo.jpg');
    const res = await fetch(`${API_BASE}/api/users/me/photo`, { method: 'PUT', headers: { Authorization: `Bearer ${state.token}` }, body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save the photo');
    state.user = { ...state.user, photoVersion: data.photoVersion };
    await electronAPI.storeSet('user', state.user);
    paintOwnAvatar();
    paintProfilePhotoPreview();
    showToast('Photo updated.', 'success');
  } catch (err) {
    console.error('Set photo error:', err);
    showToast(err.message || 'Could not use that picture.', 'error');
  }
}

async function removeOwnPhoto() {
  try {
    const res = await api('/api/users/me/photo', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not remove the photo');
    state.user = { ...state.user, photoVersion: null };
    await electronAPI.storeSet('user', state.user);
    paintOwnAvatar();
    paintProfilePhotoPreview();
    showToast('Photo removed.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not remove the photo.', 'error');
  }
}

function setupProfilePhoto() {
  const input = document.getElementById('profile-photo-input');
  document.getElementById('btn-profile-photo')?.addEventListener('click', () => input?.click());
  document.getElementById('btn-profile-photo-remove')?.addEventListener('click', removeOwnPhoto);
  input?.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) setOwnPhoto(file);
  });
}
