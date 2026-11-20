// The release script's pure parts: putting the changelog notes into the update file, and choosing which files to publish.
const test = require('node:test');
const assert = require('node:assert/strict');
const { addReleaseNotes, filesToPublish } = require('../scripts/release');

const yml = `version: 1.1.0
files:
  - url: IT-Avenue-Workspace-Setup-1.1.0.exe
    sha512: abc
    size: 123
path: IT-Avenue-Workspace-Setup-1.1.0.exe
sha512: abc
releaseDate: '2026-11-20T01:00:00.000Z'
`;

test('the notes go into the update file as a block that survives colons, quotes and blank lines', () => {
  const out = addReleaseNotes(yml, 'New\n- Knowledge Base: answers\n- "Quoted" text\n\nFixed\n- A bug');
  assert.match(out, /releaseNotes: \|\n  New\n  - Knowledge Base: answers\n  - "Quoted" text\n\n  Fixed\n  - A bug\n$/);
  assert.match(out, /^version: 1\.1\.0/);
  assert.equal(out.includes('sha512: abc'), true, 'the rest of the file is untouched');
});

test('running it twice does not repeat the notes', () => {
  const once = addReleaseNotes(yml, 'New\n- One');
  const twice = addReleaseNotes(once, 'New\n- One');
  assert.equal((twice.match(/releaseNotes:/g) || []).length, 1);
  assert.equal(twice, once);
});

test('the files published are this version\'s installer, its block map and the update file, and nothing else', () => {
  const listing = ['IT-Avenue-Workspace-Setup-1.1.0.exe', 'IT-Avenue-Workspace-Setup-1.1.0.exe.blockmap', 'IT-Avenue-Workspace-Setup-1.0.0.exe', 'latest.yml', 'builder-debug.yml', 'win-unpacked'];
  assert.deepEqual(filesToPublish(listing, '1.1.0').sort(), ['IT-Avenue-Workspace-Setup-1.1.0.exe', 'IT-Avenue-Workspace-Setup-1.1.0.exe.blockmap', 'latest.yml']);
  assert.deepEqual(filesToPublish(['latest.yml'], '1.1.0'), null, 'a missing installer means the build is not complete');
});
