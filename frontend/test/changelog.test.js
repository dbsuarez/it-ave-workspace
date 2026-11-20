// The changelog: parsing CHANGELOG.md, what to show after an update, the notes for a release, and the app's copy staying in step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseChangelog, compareVersions, entriesSince, notesFor, whatsNewHtml } = require('../src/features/changelog');

const sample = `# What's new in IT Avenue Workspace

## 1.2.0 - 2026-12-01
### New
- Backup list with names
- **Dark** mode for <Sheets>

### Fixed
- A table cell broke a line

## 1.1.0 - 2026-11-20
### New
- Knowledge Base

## 1.0.0 - 2026-10-01
First version.
`;

test('the changelog is read as versions, newest first, each with titled groups of items', () => {
  const entries = parseChangelog(sample);
  assert.deepEqual(entries.map((e) => e.version), ['1.2.0', '1.1.0', '1.0.0']);
  assert.equal(entries[0].date, '2026-12-01');
  assert.deepEqual(entries[0].groups.map((g) => g.title), ['New', 'Fixed']);
  assert.deepEqual(entries[0].groups[0].items, ['Backup list with names', '**Dark** mode for <Sheets>']);
  assert.deepEqual(entries[2].groups, [{ title: '', items: ['First version.'] }], 'text without a group becomes one untitled item');
  assert.deepEqual(parseChangelog(''), []);
  assert.deepEqual(parseChangelog('# nothing here'), []);
});

test('versions compare as numbers, not text', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
});

test('after an update the person sees what came since the version they last saw, never anything newer than the one they run', () => {
  const entries = parseChangelog(sample);
  assert.deepEqual(entriesSince(entries, '1.0.0', '1.2.0').map((e) => e.version), ['1.2.0', '1.1.0']);
  assert.deepEqual(entriesSince(entries, '1.1.0', '1.1.0'), [], 'nothing new');
  assert.deepEqual(entriesSince(entries, '1.0.0', '1.1.0').map((e) => e.version), ['1.1.0'], 'a newer entry than the running app is not shown');
  assert.deepEqual(entriesSince(entries, null, '1.2.0').map((e) => e.version), ['1.2.0'], 'a first run shows only the current version');
  assert.deepEqual(entriesSince(entries, '1.0.0', '9.9.9').map((e) => e.version), ['1.2.0', '1.1.0']);
});

test('the notes for a release are plain text for the update file', () => {
  const entries = parseChangelog(sample);
  const notes = notesFor(entries, '1.2.0');
  assert.match(notes, /New\n- Backup list with names/);
  assert.match(notes, /Fixed\n- A table cell broke a line/);
  assert.equal(notes.includes('1.1.0'), false);
  assert.equal(notesFor(entries, '3.0.0'), null, 'a version without an entry has no notes');
});

test('the what\'s new window shows each version with its groups, and escapes what it prints', () => {
  const html = whatsNewHtml(parseChangelog(sample).slice(0, 2));
  assert.match(html, /1\.2\.0/);
  assert.match(html, /2026-12-01|1 Dec|December/);
  assert.match(html, /<h4[^>]*>New<\/h4>/);
  assert.match(html, /&lt;Sheets&gt;/);
  assert.doesNotMatch(html, /<Sheets>/);
  assert.match(html, /<strong>Dark<\/strong>/, 'bold is kept');
  assert.equal(whatsNewHtml([]), '');
});

test('the real changelog is well formed and never names the all-powerful roles to employees', () => {
  const real = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
  const entries = parseChangelog(real);
  assert.ok(entries.length >= 1);
  const pkg = require('../package.json');
  assert.equal(entries[0].version, pkg.version, 'the newest changelog entry is the version in package.json');
  assert.doesNotMatch(real, /\b(Owner|Owners|Admin|Superadmin|administrator)\b/i);
});

test('the copy the app loads is in step with CHANGELOG.md', () => {
  const { generate } = require('../scripts/sync-changelog');
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'changelog-data.js'), 'utf8');
  assert.equal(onDisk, generate(), 'run `npm run changelog` in frontend/');
});
