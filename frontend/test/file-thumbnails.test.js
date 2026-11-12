const test = require('node:test');
const assert = require('node:assert/strict');
const { isThumbnailable, thumbnailSize, THUMB_SIZE } = require('../src/features/file-thumbnails');

test('pictures the browser can draw get a thumbnail; everything else keeps its icon', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/JPG', 'image/gif', 'image/webp', 'image/bmp']) assert.equal(isThumbnailable(type), true, type);
  for (const type of ['application/pdf', 'text/plain', 'video/mp4', 'image/svg+xml', 'image/tiff', '', null, undefined]) assert.equal(isThumbnailable(type), false, String(type));
});

test('the long side is shrunk to the thumbnail size, keeping the shape; small pictures are not enlarged', () => {
  assert.equal(THUMB_SIZE, 320);
  assert.deepEqual(thumbnailSize(4000, 3000), { width: 320, height: 240 });
  assert.deepEqual(thumbnailSize(1000, 2000), { width: 160, height: 320 });
  assert.deepEqual(thumbnailSize(100, 80), { width: 100, height: 80 }, 'never enlarged');
  assert.deepEqual(thumbnailSize(5000, 1), { width: 320, height: 1 }, 'never zero');
});
