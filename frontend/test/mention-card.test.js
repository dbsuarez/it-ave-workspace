// The profile card on a mention alone on its line: details, photo hook, Message and Huddle buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Text', 'DocumentFragment', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'Range', 'Selection', 'DOMParser', 'XMLSerializer', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
const { createCanvasEditor } = require('../editor-src/canvas-editor');

function card(person, photoUrl) {
  globalThis.canvasMentionLookup = () => person;
  globalThis.canvasUserPhoto = photoUrl === undefined ? undefined : () => Promise.resolve(photoUrl);
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = createCanvasEditor(element, { content: '@ann\n' });
  const found = editor.view.dom.querySelector('.cw-mention-solo .cw-mention-card');
  return { found, editor };
}

test.afterEach(() => {
  delete globalThis.canvasMentionLookup;
  delete globalThis.canvasUserPhoto;
});

test('someone else gets Message and Huddle buttons that carry their id', () => {
  const { found, editor } = card({ id: 7, username: 'ann', email: 'ann@x.test', status: 'online' });
  assert.equal(found.querySelector('[data-message-user]').getAttribute('data-message-user'), '7');
  assert.equal(found.querySelector('[data-huddle-user]').getAttribute('data-huddle-user'), '7');
  assert.match(found.querySelector('[data-huddle-user]').textContent, /Huddle/);
  editor.destroy();
});

test('your own card has no buttons to message or call yourself', () => {
  const { found, editor } = card({ id: 7, username: 'ann', isSelf: true });
  assert.equal(found.querySelector('[data-message-user]'), null);
  assert.equal(found.querySelector('[data-huddle-user]'), null);
  editor.destroy();
});

test('a profile photo replaces the initial once it has loaded', async () => {
  const { found, editor } = card({ id: 7, username: 'ann', photoVersion: 3 }, 'blob:photo-url');
  assert.equal(found.querySelector('.cw-mention-avatar').textContent, 'A', 'the initial shows first');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const avatar = found.querySelector('.cw-mention-avatar');
  assert.match(avatar.style.backgroundImage, /blob:photo-url/);
  assert.equal(avatar.textContent, '');
  editor.destroy();
});

test('no photo version, no photo request', async () => {
  let asked = 0;
  globalThis.canvasMentionLookup = () => ({ id: 7, username: 'ann' });
  globalThis.canvasUserPhoto = () => { asked += 1; return Promise.resolve('x'); };
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = createCanvasEditor(element, { content: '@ann\n' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked, 0);
  editor.destroy();
});
