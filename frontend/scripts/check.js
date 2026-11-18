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
const scripts = ['main.js', 'preload.js', 'server-config.js', 'ipc-policy.js', 'src/renderer.js', 'src/login.js', ...featureScripts];
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
  // Native dialogs are not allowed anywhere: use the in-app ones from src/features/dialogs.js.
  if (file.startsWith('src/') && file !== 'src/features/dialogs.js') {
    const native = code.match(/(?:^|[^.\w])(?:window\.)?(confirm|alert|prompt)\s*\(/m);
    if (native) {
      const replacement = { confirm: 'await confirmAction({ title, message, confirmLabel })', alert: 'await showMessage(message)', prompt: 'await askText(message)' }[native[1]];
      problems.push(`${file}: native ${native[1]}() is not allowed (Electron does not support prompt(), and native boxes break the app's look); use ${replacement} from features/dialogs.js`);
    }
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

// The in-app Help is generated from docs/USER_GUIDE.md; a stale copy would show an old guide.
try {
  const { generate, outPath } = require('./sync-help');
  if (!fs.existsSync(outPath) || fs.readFileSync(outPath, 'utf8') !== generate()) {
    problems.push('src/features/help-guide.js is out of step with docs/USER_GUIDE.md: run `npm run help`');
  }
} catch (err) {
  problems.push(`help guide: ${err.message}`);
}

if (problems.length) {
  console.error('Desktop client check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`Desktop client check passed (${scripts.length} scripts, ${pages.length + styles.length} pages and styles).`);
