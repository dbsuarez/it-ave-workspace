// Bundles the drawing editor (editor-src/drawing-editor.js: Excalidraw and React) into one browser script,
// src/vendor/drawing-editor.js (global ITADrawing), and copies the editor's stylesheet and fonts to src/vendor/drawing-assets/,
// so the app loads nothing from node_modules or the internet at runtime.
// Run `npm run drawing` after changing editor-src/drawing-editor.js or upgrading @excalidraw/excalidraw; the output is committed.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const packageDist = path.join(root, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod');
const assetsOut = path.join(root, 'src', 'vendor', 'drawing-assets');

// Excalidraw reads window.EXCALIDRAW_ASSET_PATH to find its fonts; point it at our copy, next to this script.
const banner = `(function(){var s=document.currentScript;if(!window.EXCALIDRAW_ASSET_PATH&&s&&s.src){window.EXCALIDRAW_ASSET_PATH=s.src.replace(/[^/]*$/,'')+'drawing-assets/';}})();`;

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    if (entry.isDirectory()) copyDir(source, path.join(to, entry.name));
    else fs.copyFileSync(source, path.join(to, entry.name));
  }
}

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'editor-src', 'drawing-editor.js')],
    outfile: path.join(root, 'src', 'vendor', 'drawing-editor.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'ITADrawing',
    platform: 'browser',
    target: 'chrome120',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
    banner: { js: banner },
    logLevel: 'info',
  });
  fs.rmSync(assetsOut, { recursive: true, force: true });
  fs.mkdirSync(assetsOut, { recursive: true });
  fs.copyFileSync(path.join(packageDist, 'index.css'), path.join(assetsOut, 'excalidraw.css'));
  copyDir(path.join(packageDist, 'fonts'), path.join(assetsOut, 'fonts'));
  console.log('Wrote src/vendor/drawing-editor.js and src/vendor/drawing-assets/.');
})().catch((err) => { console.error(err); process.exit(1); });
