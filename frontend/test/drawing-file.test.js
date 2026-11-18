const test = require('node:test');
const assert = require('node:assert/strict');
const { drawingFileJson, parseDrawingFile, drawingFileBaseName, DRAWING_FILE_MAX_BYTES } = require('../src/features/drawing-file');

const shape = (id, extra = {}) => ({ id, type: 'rectangle', version: 2, versionNonce: 9, x: 1, y: 2, width: 3, height: 4, isDeleted: false, ...extra });
const picture = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 1 };

test('a saved file is an Excalidraw scene with only the shapes that are still there', () => {
  const text = drawingFileJson([shape('a'), shape('img', { type: 'image', fileId: 'f1' }), shape('gone', { isDeleted: true })], { f1: picture });
  const file = JSON.parse(text);
  assert.equal(file.type, 'excalidraw');
  assert.equal(file.version, 2);
  assert.deepEqual(file.elements.map((item) => item.id), ['a', 'img']);
  assert.deepEqual(Object.keys(file.files), ['f1']);
  assert.ok(file.appState && typeof file.appState === 'object');
});

test('pictures nobody uses any more are left out of the saved file', () => {
  const used = shape('img', { type: 'image', fileId: 'f1' });
  const text = drawingFileJson([used], { f1: picture, f2: { ...picture, id: 'f2' } });
  assert.deepEqual(Object.keys(JSON.parse(text).files), ['f1']);
});

test('a file saved here can be read back', () => {
  const back = parseDrawingFile(drawingFileJson([shape('a'), shape('b')], {}));
  assert.deepEqual(back.elements.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(back.files, {});
});

test('a file from excalidraw.com is accepted, deleted shapes are skipped', () => {
  const text = JSON.stringify({ type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements: [shape('a'), shape('x', { isDeleted: true })], appState: { gridSize: null }, files: { f1: picture } });
  const back = parseDrawingFile(text);
  assert.deepEqual(back.elements.map((item) => item.id), ['a']);
  assert.equal(back.files.f1.dataURL, picture.dataURL);
});

test('things that are not a drawing file give a plain message', () => {
  assert.throws(() => parseDrawingFile('not json at all'), /not a drawing file/i);
  assert.throws(() => parseDrawingFile('{"type":"something-else","elements":[]}'), /not a drawing file/i);
  assert.throws(() => parseDrawingFile('{"type":"excalidraw","elements":"nope"}'), /not a drawing file/i);
  assert.throws(() => parseDrawingFile(''), /not a drawing file/i);
});

test('a file with nothing in it is refused, and so is one that is too large', () => {
  assert.throws(() => parseDrawingFile('{"type":"excalidraw","elements":[]}'), /nothing in it/i);
  assert.throws(() => parseDrawingFile(' '.repeat(DRAWING_FILE_MAX_BYTES + 1)), /too large/i);
});

test('shapes without an id or type are dropped instead of breaking the drawing', () => {
  const text = JSON.stringify({ type: 'excalidraw', elements: [shape('ok'), { type: 'rectangle' }, { id: 'no-type' }, null, 7] });
  assert.deepEqual(parseDrawingFile(text).elements.map((item) => item.id), ['ok']);
});

test('the file name comes from the title, safe for any computer', () => {
  assert.equal(drawingFileBaseName('Rack layout: floor 3/B'), 'Rack_layout_floor_3_B');
  assert.equal(drawingFileBaseName(''), 'drawing');
  assert.equal(drawingFileBaseName('Network map.excalidraw'), 'Network_map');
});
