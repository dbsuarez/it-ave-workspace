// Build guard for the desktop client. A parse error in a renderer script kills
// the window before any handler attaches, so fail the build instead.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const featureDir = path.join(root, 'src', 'features');
const featureScripts = fs.existsSync(featureDir)
  ? fs.readdirSync(featureDir).filter((name) => name.endsWith('.js')).sort().map((name) => `src/features/${name}`)
  : [];
const scripts = ['main.js', 'preload.js', 'src/renderer.js', 'src/login.js', ...featureScripts];
const pages = ['src/index.html', 'src/login.html'];
const styles = ['src/styles.css'];
const problems = [];

for (const file of scripts) {
  const code = fs.readFileSync(path.join(root, file), 'utf8');
  try {
    new vm.Script(code, { filename: file });
  } catch (err) {
    problems.push(`${file}: ${err.message}`);
  }
  // The preload exposes window.electronAPI; declaring it again is a parse-time
  // error in the page that node cannot see.
  if (file.startsWith('src/') && /\b(?:const|let|var|function|class)\s+electronAPI\b/.test(code)) {
    problems.push(`${file}: must not declare "electronAPI" (the preload already defines it)`);
  }
  if (file.startsWith('src/') && /(^|[^.\w])prompt\s*\(/.test(code)) {
    problems.push(`${file}: window.prompt() is not supported in Electron; use askText()`);
  }
}

// The page scripts are classic scripts that share one global scope, so a name
// declared at the top level of two of them silently overrides or crashes.
const pageScripts = ['src/renderer.js', ...featureScripts];
const declaredIn = new Map();
for (const file of pageScripts) {
  const code = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of code.matchAll(/^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = match[1];
    if (declaredIn.has(name) && declaredIn.get(name) !== file) {
      problems.push(`${file}: top-level "${name}" is also declared in ${declaredIn.get(name)}`);
    } else if (declaredIn.has(name)) {
      problems.push(`${file}: top-level "${name}" is declared twice`);
    }
    declaredIn.set(name, file);
  }
}

for (const file of [...pages, ...styles]) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (text.includes('node_modules')) {
    problems.push(`${file}: must not load from node_modules; use src/vendor (npm run vendor)`);
  }
  for (const match of text.matchAll(/(?:src|href)="([^"#:]+)"|url\('([^':]+)'\)/g)) {
    const ref = match[1] || match[2];
    const target = path.join(root, path.dirname(file), ref);
    if (!fs.existsSync(target)) problems.push(`${file}: missing local file ${ref}`);
  }
}

if (problems.length) {
  console.error('Desktop client check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`Desktop client check passed (${scripts.length} scripts, ${pages.length + styles.length} pages and styles).`);
