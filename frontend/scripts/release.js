// `npm run release` builds the Windows installer and puts the update files where the app looks for them.
//   1. checks CHANGELOG.md has an entry for the version in package.json (bump the version and write the entry first)
//   2. builds the installer with electron-builder (no publishing to anywhere)
//   3. writes that version's changelog notes into latest.yml, so the app can show them
//   4. copies the installer, its block map and latest.yml to the updates folder:
//        UPDATES_DIR (environment variable), or ../updates next to docker-compose.yml, which the web server serves at /updates/
// Copying to another computer is a separate step (see deploy/README.md): point UPDATES_DIR at a shared or mounted folder, or copy it after.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseChangelog, notesFor } = require('../src/features/changelog');

const root = path.join(__dirname, '..');
const STABLE_INSTALLER = 'IT-Avenue-Workspace-Setup.exe';

// latest.yml with the release notes added as a YAML block (replacing any notes already there).
function addReleaseNotes(yamlText, notes) {
  const lines = String(yamlText).replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (/^releaseNotes:/.test(line)) { skipping = true; continue; }
    if (skipping && (line === '' || /^\s/.test(line))) continue; // the old block, indented under releaseNotes
    skipping = false;
    kept.push(line);
  }
  const base = `${kept.join('\n').replace(/\n+$/, '')}\n`;
  const block = String(notes).split('\n').map((line) => (line ? `  ${line}` : '')).join('\n');
  return `${base}releaseNotes: |\n${block}\n`;
}

// Which of the files in dist/ are published for this version; null when the installer or the update file is missing.
function filesToPublish(listing, version) {
  const wanted = (name) => name === 'latest.yml' || name === `IT-Avenue-Workspace-Setup-${version}.exe` || name === `IT-Avenue-Workspace-Setup-${version}.exe.blockmap`;
  const files = listing.filter(wanted);
  return files.includes('latest.yml') && files.includes(`IT-Avenue-Workspace-Setup-${version}.exe`) ? files : null;
}

function main() {
  const { version } = require('../package.json');
  const changelog = fs.readFileSync(path.join(root, '..', 'CHANGELOG.md'), 'utf8');
  const notes = notesFor(parseChangelog(changelog), version);
  if (!notes) { console.error(`CHANGELOG.md has no entry for version ${version}. Write it, run "npm run changelog", then release again.`); process.exit(1); }
  const dest = path.resolve(process.env.UPDATES_DIR || path.join(root, '..', 'updates'));

  const sync = spawnSync(process.execPath, [path.join(__dirname, 'sync-changelog.js')], { stdio: 'inherit' });
  if (sync.status !== 0) process.exit(sync.status || 1);
  const build = spawnSync('npx', ['electron-builder', '--win', '--publish', 'never'], { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) { console.error('The build failed, nothing was published.'); process.exit(build.status || 1); }

  const dist = path.join(root, 'dist');
  const files = filesToPublish(fs.readdirSync(dist), version);
  if (!files) { console.error(`dist/ does not hold the installer and latest.yml for version ${version}.`); process.exit(1); }
  const ymlPath = path.join(dist, 'latest.yml');
  fs.writeFileSync(ymlPath, addReleaseNotes(fs.readFileSync(ymlPath, 'utf8'), notes));

  fs.mkdirSync(dest, { recursive: true });
  // the installer and block map first, the update file last: an app never sees a version whose installer is not there yet
  for (const name of [...files.filter((f) => f !== 'latest.yml'), 'latest.yml']) fs.copyFileSync(path.join(dist, name), path.join(dest, name));
  // a link that never changes: always the newest installer (for the install note and for sending to new people)
  fs.copyFileSync(path.join(dist, `IT-Avenue-Workspace-Setup-${version}.exe`), path.join(dest, STABLE_INSTALLER));
  fs.copyFileSync(path.join(root, '..', 'CHANGELOG.md'), path.join(dest, 'CHANGELOG.md'));
  console.log(`\nVersion ${version} is in ${dest}\nApps will find it at <server address>/updates/ within a few hours (or at their next start).`);
}

if (require.main === module) main();

module.exports = { addReleaseNotes, filesToPublish, STABLE_INSTALLER };
