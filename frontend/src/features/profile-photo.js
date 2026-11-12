// IT Avenue Workspace - profile photos.
//
// A photo is fetched with the signed-in request (there is no public URL) and shown from a blob URL that is
// cached per person and per version, so a changed photo shows up and an unchanged one is fetched once.
// Setting one: pick a picture, it is cropped to a square and shrunk to 256px, then uploaded (PUT /api/users/me/photo).
//
// Loaded before renderer.js; renderer.js calls paintOwnAvatar / refreshOwnProfile / setupProfilePhoto.

const photoUrlCache = new Map(); // "id:version" -> Promise<blob URL | null>
const PHOTO_SIZE = 256;

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

// The sign-in response has no job title or photo; fetch the full profile once the app is up.
async function refreshOwnProfile() {
  try {
    const res = await api('/api/auth/me');
    const data = await res.json();
    if (!res.ok || !data.user) return;
    state.user = { ...state.user, jobTitle: data.user.jobTitle || '', photoVersion: data.user.photoVersion || null };
    await electronAPI.storeSet('user', state.user);
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

// A square, 256px JPEG cut from the middle of the chosen picture.
async function squarePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(PHOTO_SIZE, PHOTO_SIZE);
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}

async function setOwnPhoto(file) {
  try {
    const blob = await squarePhoto(file);
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
