// Where the app looks for updates, and what the update banner says. Pure: no Electron needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { feedUrlFor, nextUpdateState } = require('../update-policy');
const { updateBannerHtml } = require('../src/features/update-banner');

test('updates are read from the app\'s own server over HTTPS (plain HTTP only for this computer)', () => {
  assert.equal(feedUrlFor('https://chat.example.com'), 'https://chat.example.com/updates/');
  assert.equal(feedUrlFor('https://chat.example.com/'), 'https://chat.example.com/updates/');
  assert.equal(feedUrlFor('https://10.0.0.5:8443'), 'https://10.0.0.5:8443/updates/');
  assert.equal(feedUrlFor('http://127.0.0.1:3001'), 'http://127.0.0.1:3001/updates/');
  assert.equal(feedUrlFor('http://localhost:3001'), 'http://localhost:3001/updates/');
  assert.equal(feedUrlFor('http://192.168.1.20:3001'), null, 'plain HTTP over a network is not trusted');
  assert.equal(feedUrlFor('ftp://x'), null);
  assert.equal(feedUrlFor('not a url'), null);
  assert.equal(feedUrlFor(''), null);
  assert.equal(feedUrlFor('https://user:pass@chat.example.com'), null, 'no credentials in the address');
});

test('the update state moves through checking, downloading and ready, and keeps the version', () => {
  let state = nextUpdateState({ status: 'idle' }, { type: 'checking' });
  assert.equal(state.status, 'checking');
  state = nextUpdateState(state, { type: 'available', version: '1.2.0' });
  assert.deepEqual([state.status, state.version], ['downloading', '1.2.0']);
  state = nextUpdateState(state, { type: 'progress', percent: 41.6 });
  assert.equal(state.percent, 42);
  state = nextUpdateState(state, { type: 'downloaded', version: '1.2.0' });
  assert.deepEqual([state.status, state.version, state.percent], ['ready', '1.2.0', 100]);
  assert.equal(nextUpdateState(state, { type: 'checking' }).status, 'ready', 'a ready update is not forgotten by the next check');
  assert.equal(nextUpdateState({ status: 'checking' }, { type: 'none' }).status, 'none');
  const failed = nextUpdateState({ status: 'checking' }, { type: 'error', message: 'offline' });
  assert.deepEqual([failed.status, failed.message], ['error', 'offline']);
  assert.equal(nextUpdateState(state, { type: 'error', message: 'x' }).status, 'ready', 'an error after the download keeps the ready update');
});

test('the banner appears only when there is something to say, and asks before restarting', () => {
  assert.equal(updateBannerHtml({ status: 'idle' }), '');
  assert.equal(updateBannerHtml({ status: 'none' }), '');
  assert.equal(updateBannerHtml({ status: 'checking' }), '');
  assert.equal(updateBannerHtml({ status: 'error', message: 'offline' }), '', 'a failed check is not shown to people');
  assert.match(updateBannerHtml({ status: 'downloading', version: '1.2.0', percent: 40 }), /1\.2\.0[\s\S]*40%/);
  const ready = updateBannerHtml({ status: 'ready', version: '1.2.0' });
  assert.match(ready, /Version 1\.2\.0 is ready/);
  assert.match(ready, /data-update-install/);
  assert.match(ready, /data-update-later/);
  assert.match(ready, /installs? (it )?when you (close|quit|restart)/i);
  assert.equal(/<script|onerror/i.test(updateBannerHtml({ status: 'ready', version: '<script>' })), false);
});
