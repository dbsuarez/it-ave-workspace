// Which third-party addresses may appear as text in the Excalidraw bundle, and a scan that finds the others.
// Used by test/drawing-bundle.test.js and by scripts/check.js, so a new address fails the build until someone reviews it.
const fs = require('fs');
const path = require('path');

// Hosts that appear as text inside the bundle, each with why it is not a request the app makes. The text sits in Excalidraw's code
// for features that are off or not shown here; the authoritative proof is the offline browser check (Task 1 step 5, Task 8 step 5),
// which fails on any attempted outside request.
const INERT = 'a documentation or social link in text; opening one needs a click and goes to the system browser (main.js confineNavigation)';
const ALLOWED_HOSTS = {
  'www.w3.org': 'XML and SVG namespace identifiers, never fetched',
  'reactjs.org': 'React error-decoder text in a message',
  'react.dev': 'React error-decoder text in a message',
  'esm.sh': 'the fallback asset location used only when EXCALIDRAW_ASSET_PATH is unset; the build banner always sets it',
  'json.excalidraw.com': 'share-link export, a feature this app does not show',
  'libraries.excalidraw.com': 'the public shape library, not shown; link only',
  'us-central1-excalidraw-room-persistence.cloudfunctions.net': 'the public library publishing service, not shown',
  'excalidraw-room-persistence.firebaseio.com': 'the collaboration storage of the original Excalidraw app; this app has its own',
  'oss-collab.excalidraw.com': 'the collaboration server of the original Excalidraw app; this app has its own',
  'oss-ai.excalidraw.com': 'text-to-diagram service; turned off with aiEnabled: false',
  'www.youtube.com': 'embedded web pages; turned off with validateEmbeddable: false',
  'youtube.com': INERT,
  'player.vimeo.com': 'embedded web pages; turned off with validateEmbeddable: false',
  'www.figma.com': 'embedded web pages; turned off with validateEmbeddable: false',
  'twitter.com': 'embedded web pages; turned off with validateEmbeddable: false',
  'platform.twitter.com': 'embedded web pages; turned off with validateEmbeddable: false',
  'reddit.com': 'embedded web pages; turned off with validateEmbeddable: false',
  'embed.reddit.com': 'embedded web pages; turned off with validateEmbeddable: false',
  'gist.github.com': 'embedded web pages; turned off with validateEmbeddable: false',
  'giphy.com': 'embedded web pages; turned off with validateEmbeddable: false',
  'github.com': INERT,
  'chevrotain.io': INERT,
  'langium.org': INERT,
  'en.wikipedia.org': INERT,
  'docs.excalidraw.com': INERT,
  'mermaid.js.org': INERT,
  'plus.excalidraw.com': INERT,
  'app.excalidraw.com': INERT,
  'x.com': INERT,
  'discord.gg': INERT,
};

function filesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(full) : [full];
  });
}

// -> a list of "file: address" for every address whose host is not in ALLOWED_HOSTS
function findOutsideAddresses(vendorDir) {
  const bundle = path.join(vendorDir, 'drawing-editor.js');
  const assets = path.join(vendorDir, 'drawing-assets');
  const backslash = String.fromCharCode(92);
  const stop = [backslash + 's', '"', "'", '`', ')', backslash + backslash].join('');
  const pattern = new RegExp('https?://([a-z0-9.-]+)[^' + stop + ']*', 'gi');
  const offenders = [];
  for (const file of [bundle, ...filesIn(assets).filter((f) => /\.(js|css|json|html)$/i.test(f))]) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      if (!ALLOWED_HOSTS[match[1].toLowerCase()]) offenders.push(`${path.relative(vendorDir, file)}: ${match[0].slice(0, 80)}`);
    }
  }
  return [...new Set(offenders)];
}

module.exports = { ALLOWED_HOSTS, findOutsideAddresses, filesIn };
