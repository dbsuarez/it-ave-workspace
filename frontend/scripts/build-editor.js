// Bundles the rich-text canvas editor (editor-src/) with TipTap into one browser script,
// src/vendor/canvas-editor.js (global ITAEditor), so the app loads no packages from node_modules at runtime.
// Run `npm run editor` after changing editor-src/ or upgrading @tiptap/*; the output is committed.
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

esbuild.build({
  entryPoints: [path.join(root, 'editor-src', 'canvas-editor.js')],
  outfile: path.join(root, 'src', 'vendor', 'canvas-editor.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'ITAEditor',
  platform: 'browser',
  target: 'chrome120',
  legalComments: 'none',
  logLevel: 'info',
}).catch(() => process.exit(1));
