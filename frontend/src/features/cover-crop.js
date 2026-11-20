// IT Avenue Workspace - positioning a cover photo before it is saved: the math (pure; covered by test/cover-crop.test.js). The picture sits
// behind a wide window; the person drags it and zooms until the part they want shows, and that part is cut out and saved at 1500 x 300 (5:1).
// Like photo-crop.js, but for a rectangle: a state is { w, h, viewW, viewH, zoom, ox, oy } - the picture's natural size, the window size, a zoom from 1
// (the picture just covers the window) up to 4, and where the picture's top-left corner is in the window (never past an edge).

const COVER_WIDTH = 1500;
const COVER_HEIGHT = 300;
const COVER_MAX_ZOOM = 4;

const coverBaseScale = (state) => Math.max(state.viewW / state.w, state.viewH / state.h);
const coverScaleOf = (state) => coverBaseScale(state) * state.zoom;

function coverClamp(state) {
  const s = coverScaleOf(state);
  return {
    ...state,
    ox: Math.min(0, Math.max(state.viewW - state.w * s, state.ox)),
    oy: Math.min(0, Math.max(state.viewH - state.h * s, state.oy)),
  };
}

// The picture centred in the window at zoom 1.
function coverInitialState(w, h, viewW, viewH) {
  const base = { w, h, viewW, viewH, zoom: 1, ox: 0, oy: 0 };
  const s = coverScaleOf(base);
  return coverClamp({ ...base, ox: (viewW - w * s) / 2, oy: (viewH - h * s) / 2 });
}

// Move the picture by dx, dy window pixels.
function coverMoveBy(state, dx, dy) {
  return coverClamp({ ...state, ox: state.ox + dx, oy: state.oy + dy });
}

// Zoom to newZoom, keeping the point of the picture under (px, py) where it is (the centre, or the pointer).
function coverZoomAbout(state, newZoom, px, py) {
  const zoom = Math.min(COVER_MAX_ZOOM, Math.max(1, newZoom));
  const s0 = coverScaleOf(state);
  const imageX = (px - state.ox) / s0;
  const imageY = (py - state.oy) / s0;
  const next = { ...state, zoom };
  const s1 = coverScaleOf(next);
  return coverClamp({ ...next, ox: px - imageX * s1, oy: py - imageY * s1 });
}

// What the window shows, in the picture's own pixels: { sx, sy, sw, sh } (always the window's shape).
function coverSourceRect(state) {
  const s = coverScaleOf(state);
  return { sx: -state.ox / s + 0, sy: -state.oy / s + 0, sw: state.viewW / s, sh: state.viewH / s }; // + 0: never "-0"
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COVER_WIDTH, COVER_HEIGHT, COVER_MAX_ZOOM, coverInitialState, coverMoveBy, coverZoomAbout, coverSourceRect };
}
