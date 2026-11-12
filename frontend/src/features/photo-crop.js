// IT Avenue Workspace - positioning a profile photo before it is saved: the math (pure; covered by
// test/photo-crop.test.js). The picture sits behind a square window of `view` pixels; the person drags it and zooms
// until their face is where they want it, and what shows in the window is cut out and saved at 512x512.
//
// A state is { w, h, view, zoom, ox, oy }: the picture's natural size, the window size, a zoom from 1 (the picture
// just covers the window) up, and where the picture's top-left corner is in the window (never past an edge).

const PHOTO_STORE_SIZE = 512; // pixels, square: about five times the biggest place a photo is shown (96px), sharp on high-density screens
const MAX_ZOOM = 4;

const baseScale = (state) => state.view / Math.min(state.w, state.h);
const scaleOf = (state) => baseScale(state) * state.zoom;

function clampOffsets(state) {
  const s = scaleOf(state);
  return {
    ...state,
    ox: Math.min(0, Math.max(state.view - state.w * s, state.ox)),
    oy: Math.min(0, Math.max(state.view - state.h * s, state.oy)),
  };
}

// The picture centered in the window at zoom 1.
function initialState(w, h, view) {
  const base = { w, h, view, zoom: 1, ox: 0, oy: 0 };
  const s = scaleOf(base);
  return clampOffsets({ ...base, ox: (view - w * s) / 2, oy: (view - h * s) / 2 });
}

// Move the picture by dx, dy window pixels.
function moveBy(state, dx, dy) {
  return clampOffsets({ ...state, ox: state.ox + dx, oy: state.oy + dy });
}

// Zoom to newZoom, keeping the point of the picture under (px, py) where it is (the center, or the pointer).
function zoomAbout(state, newZoom, px, py) {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, newZoom));
  const s0 = scaleOf(state);
  const imageX = (px - state.ox) / s0;
  const imageY = (py - state.oy) / s0;
  const next = { ...state, zoom };
  const s1 = scaleOf(next);
  return clampOffsets({ ...next, ox: px - imageX * s1, oy: py - imageY * s1 });
}

// What the window shows, in the picture's own pixels: { sx, sy, size } (a square).
function sourceRect(state) {
  const s = scaleOf(state);
  return { sx: -state.ox / s, sy: -state.oy / s, size: state.view / s };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PHOTO_STORE_SIZE, MAX_ZOOM, baseScale, scaleOf, initialState, moveBy, zoomAbout, sourceRect };
}
