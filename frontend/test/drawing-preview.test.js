const test = require('node:test');
const assert = require('node:assert/strict');
const { drawingPreviewWanted, drawingPreviewKey } = require('../src/features/drawing-preview');

const ok = { role: 'editor', draft: false, online: true, shapes: 3 };

test('a preview is saved only by an editor, for a drawing the server knows, while connected, and when there is something drawn', () => {
  assert.equal(drawingPreviewWanted(ok), true);
  assert.equal(drawingPreviewWanted({ ...ok, role: 'viewer' }), false, 'a viewer cannot save one');
  assert.equal(drawingPreviewWanted({ ...ok, draft: true }), false, 'a draft made offline is not on the server yet');
  assert.equal(drawingPreviewWanted({ ...ok, online: false }), false);
  assert.equal(drawingPreviewWanted({ ...ok, shapes: 0 }), false, 'an empty drawing has nothing to show');
});

test('a picture is remembered by drawing and version, so a new version is fetched again', () => {
  assert.notEqual(drawingPreviewKey(4, 100), drawingPreviewKey(4, 101));
  assert.notEqual(drawingPreviewKey(4, 100), drawingPreviewKey(5, 100));
  assert.equal(drawingPreviewKey(4, 100), drawingPreviewKey('4', '100'));
});
