// The phone app (backend/public/m): its files are all there, nothing builds markup from data, and its pure helpers work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'public', 'm');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('the service worker only lists files that exist, and the manifest points at real icons', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const list = JSON.parse(sw.match(/const FILES = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
  for (const file of list) {
    if (file === './') continue;
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is listed in sw.js but missing`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(ROOT, icon.src)), icon.src);
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'), 'the sizes an installable app needs');
});

test('every script in js/ is cached by the service worker', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  for (const file of files(path.join(ROOT, 'js'))) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    assert.ok(sw.includes(`'${relative}'`), `${relative} is not in the service worker's list`);
  }
});

test('nothing in the app writes data into the page as markup (no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval)', () => {
  for (const file of files(ROOT).filter((f) => /\.(js|html)$/.test(f))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      assert.ok(!text.includes(banned), `${path.relative(ROOT, file)} uses ${banned}`);
    }
  }
});

test('the page loads only its own scripts and styles (no inline script, no other hosts)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'an inline script would be blocked by the page policy');
  assert.ok(!/(src|href)="https?:\/\//.test(html), 'no files from other servers');
  assert.match(html, /viewport-fit=cover/);
});

test('the server gives /m its own page policy, and keeps the API strict', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.use\('\/m'/);
  assert.match(server, /script-src 'self'/);
  assert.ok(!/script-src[^"]*'unsafe-inline'/.test(server), 'no unsafe-inline scripts');
  const hardening = fs.readFileSync(path.join(__dirname, '..', 'src', 'httpHardening.js'), 'utf8');
  assert.match(hardening, /default-src 'none'/, 'every other response stays locked down');
});

test('format helpers: names, days, leave counting, punches, grouping', async () => {
  const f = await import(pathToFileURL(path.join(ROOT, 'js', 'format.js')).href);
  assert.equal(f.personName({ firstName: 'Ann', middleName: 'M', lastName: 'Lee', username: 'ann' }), 'Ann M Lee');
  assert.equal(f.personName({ username: 'ann' }), 'ann');
  assert.equal(f.initialOf({ firstName: 'zed' }), 'Z');
  assert.equal(f.plural(1, 'day'), '1 day');
  assert.equal(f.plural(2, 'day'), '2 days');
  assert.equal(f.workingDays('2026-11-13', '2026-11-17'), 3, 'Fri, Mon, Tue');
  assert.equal(f.workingDays('2026-11-13', '2026-11-17', false, [{ day: '2026-11-16' }]), 2, 'a holiday is skipped');
  assert.equal(f.workingDays('2026-11-16', '2026-11-16', true), 0.5);
  assert.equal(f.workingDays('2026-11-16', '2026-11-17', true), 0, 'a half day is one day');
  assert.equal(f.workingDays('2026-11-17', '2026-11-16'), 0);
  assert.equal(f.punchLine([{ in: '08:00', out: '12:00' }, { in: '13:00', out: null }]), '08:00–12:00 · 13:00–…');
  assert.equal(f.hoursText(485), '8.08');
  assert.equal(f.hoursText(0), '');
  const groups = f.groupMessages(
    [{ s: 1, t: '2026-11-12T08:00:00Z' }, { s: 1, t: '2026-11-12T08:02:00Z' }, { s: 2, t: '2026-11-12T08:03:00Z' }, { s: 1, t: '2026-11-12T09:00:00Z' }],
    (m) => m.s, (m) => m.t
  );
  assert.deepEqual(groups.map((g) => g.items.length), [2, 1, 1], 'same sender within five minutes sits together');
});

test('every script in js/ is valid module syntax', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  for (const file of files(path.join(ROOT, 'js'))) {
    const copy = path.join(os.tmpdir(), `iav-mobile-check-${path.basename(file)}.mjs`); // .mjs so it is read as a module
    fs.writeFileSync(copy, fs.readFileSync(file));
    const result = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
    fs.unlinkSync(copy);
    assert.equal(result.status, 0, `${path.relative(ROOT, file)}: ${result.stderr}`);
  }
});
