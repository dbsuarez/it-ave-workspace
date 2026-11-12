const test = require('node:test');
const assert = require('node:assert/strict');
const { PHOTO_STORE_SIZE, initialState, moveBy, zoomAbout, sourceRect, scaleOf } = require('../src/features/photo-crop');

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message || ''} ${a} vs ${b}`);

test('photos are stored at 512 by 512', () => {
  assert.equal(PHOTO_STORE_SIZE, 512);
});

test('at first the picture is centered and just covers the window', () => {
  const s = initialState(1000, 500, 320); // landscape: the height fills the window, the sides overflow
  close(scaleOf(s), 320 / 500);
  const r = sourceRect(s);
  close(r.size, 500, 'the window shows a 500px square');
  close(r.sy, 0);
  close(r.sx, 250, 'centered across the width');
  const portrait = sourceRect(initialState(400, 800, 320));
  close(portrait.size, 400);
  close(portrait.sx, 0);
  close(portrait.sy, 200);
});

test('dragging moves the picture but never past its edges', () => {
  let s = initialState(1000, 500, 320);
  s = moveBy(s, 100, 50);
  assert.equal(s.oy, 0, 'a picture that only just covers the height cannot move up or down');
  assert.ok(s.ox <= 0);
  const far = moveBy(initialState(1000, 500, 320), -10000, 0);
  close(sourceRect(far).sx + sourceRect(far).size, 1000, 'stops at the right edge');
  const other = moveBy(initialState(1000, 500, 320), 10000, 0);
  close(sourceRect(other).sx, 0, 'stops at the left edge');
});

test('zooming in shows a smaller piece, around the point you zoom on', () => {
  const s0 = initialState(1000, 1000, 320);
  const before = sourceRect(s0);
  // the picture point under the window center before and after zooming stays the same
  const centerBefore = { x: before.sx + before.size / 2, y: before.sy + before.size / 2 };
  const s2 = zoomAbout(s0, 2, 160, 160);
  const after = sourceRect(s2);
  close(after.size, before.size / 2, 'twice the zoom shows half the width');
  close(after.sx + after.size / 2, centerBefore.x);
  close(after.sy + after.size / 2, centerBefore.y);
  // zooming on a corner keeps that corner's point under the pointer
  const s3 = zoomAbout(s0, 2, 0, 0);
  close(sourceRect(s3).sx, 0);
  close(sourceRect(s3).sy, 0);
});

test('zoom stays between 1 and 4, and zooming out re-fits the picture inside the window', () => {
  const s0 = initialState(800, 800, 320);
  assert.equal(zoomAbout(s0, 10, 160, 160).zoom, 4);
  assert.equal(zoomAbout(s0, 0.2, 160, 160).zoom, 1);
  const zoomed = moveBy(zoomAbout(s0, 4, 160, 160), -1000, -1000); // far into a corner
  const back = zoomAbout(zoomed, 1, 160, 160);
  const r = sourceRect(back);
  close(r.sx, 0);
  close(r.sy, 0);
  close(r.size, 800, 'fully zoomed out shows the whole picture again');
});

test('the cut-out always lies inside the picture', () => {
  let s = initialState(1234, 777, 320);
  for (const step of [[50, 20], [-400, -90], [13, 300], [-5, -5]]) {
    s = zoomAbout(moveBy(s, ...step), 1 + Math.abs(step[0]) / 100, 160, 160);
    const r = sourceRect(s);
    assert.ok(r.sx >= -1e-6 && r.sy >= -1e-6, 'not past the top left');
    assert.ok(r.sx + r.size <= 1234 + 1e-6 && r.sy + r.size <= 777 + 1e-6, 'not past the bottom right');
  }
});
