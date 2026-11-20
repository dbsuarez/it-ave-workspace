// Positioning a cover photo: the picture sits behind a wide window; drag and zoom choose which part is kept. Pure math.
const test = require('node:test');
const assert = require('node:assert/strict');
const { COVER_WIDTH, COVER_HEIGHT, coverInitialState, coverMoveBy, coverZoomAbout, coverSourceRect } = require('../src/features/cover-crop');

const VIEW = { w: 600, h: 120 }; // the same 5:1 shape as the stored cover

test('the stored cover is 1500 x 300, the same 5:1 shape as the window', () => {
  assert.equal(COVER_WIDTH / COVER_HEIGHT, 5);
  assert.equal(VIEW.w / VIEW.h, 5);
});

test('a picture starts centred and just covers the window, wide or tall', () => {
  const wide = coverInitialState(3000, 600, VIEW.w, VIEW.h);
  assert.deepEqual(coverSourceRect(wide), { sx: 0, sy: 0, sw: 3000, sh: 600 }, 'a 5:1 picture fits exactly');
  const tall = coverInitialState(1000, 2000, VIEW.w, VIEW.h);
  const rect = coverSourceRect(tall);
  assert.equal(rect.sw, 1000, 'the whole width is used');
  assert.equal(Math.round(rect.sh), 200, 'and a 5:1 slice of the height');
  assert.equal(Math.round(rect.sy), 900, 'from the middle');
});

test('the picture can never be dragged so far that the window shows empty space', () => {
  let crop = coverInitialState(1000, 2000, VIEW.w, VIEW.h);
  crop = coverMoveBy(crop, 0, 100000);
  assert.equal(coverSourceRect(crop).sy, 0, 'stops at the top edge');
  crop = coverMoveBy(crop, 0, -100000);
  const rect = coverSourceRect(crop);
  assert.ok(Math.abs(rect.sy + rect.sh - 2000) < 1e-6, 'stops at the bottom edge');
  crop = coverMoveBy(crop, 5000, 0);
  assert.equal(coverSourceRect(crop).sx, 0, 'a picture as wide as the window cannot move sideways');
});

test('zooming keeps the point under the pointer where it is, and stays between 1x and 4x', () => {
  const start = coverInitialState(3000, 1500, VIEW.w, VIEW.h);
  const before = coverSourceRect(start);
  const zoomed = coverZoomAbout(start, 2, VIEW.w / 2, VIEW.h / 2);
  const after = coverSourceRect(zoomed);
  assert.ok(Math.abs((before.sx + before.sw / 2) - (after.sx + after.sw / 2)) < 1e-6, 'the centre stays');
  assert.ok(Math.abs(after.sw - before.sw / 2) < 1e-6, 'twice as close');
  assert.equal(coverZoomAbout(start, 99, 0, 0).zoom, 4);
  assert.equal(coverZoomAbout(start, 0.1, 0, 0).zoom, 1);
  assert.equal(coverSourceRect(coverZoomAbout(start, 3, 0, 0)).sx >= 0, true, 'never past the left edge');
});

test('the kept slice always has the window\'s shape, so the saved cover is never stretched', () => {
  for (const [w, h] of [[4000, 900], [1200, 1200], [800, 3000]]) {
    let crop = coverInitialState(w, h, VIEW.w, VIEW.h);
    crop = coverZoomAbout(crop, 2.5, 100, 40);
    crop = coverMoveBy(crop, -30, 12);
    const rect = coverSourceRect(crop);
    assert.ok(Math.abs(rect.sw / rect.sh - 5) < 1e-6, `${w}x${h}`);
  }
});
