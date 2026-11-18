// Bundles the Sheets grid (editor-src/sheet-grid.js: Jspreadsheet CE, jSuites and the formula add-on, all MIT) into one browser
// script, src/vendor/sheet-grid.js (global ITASheet), and copies the stylesheets to src/vendor/sheet-assets/, so the app loads
// nothing from node_modules or the internet at runtime. Run `npm run sheets` after changing editor-src/sheet-grid.js or upgrading
// jspreadsheet-ce; the output is committed.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const assetsOut = path.join(root, 'src', 'vendor', 'sheet-assets');

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'editor-src', 'sheet-grid.js')],
    outfile: path.join(root, 'src', 'vendor', 'sheet-grid.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'ITASheet',
    platform: 'browser',
    target: 'chrome120',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });
  fs.rmSync(assetsOut, { recursive: true, force: true });
  fs.mkdirSync(assetsOut, { recursive: true });
  fs.copyFileSync(path.join(root, 'node_modules', 'jspreadsheet-ce', 'dist', 'jspreadsheet.css'), path.join(assetsOut, 'jspreadsheet.css'));
  fs.copyFileSync(path.join(root, 'node_modules', 'jsuites', 'dist', 'jsuites.css'), path.join(assetsOut, 'jsuites.css'));
  console.log('Wrote src/vendor/sheet-grid.js and src/vendor/sheet-assets/.');
})().catch((err) => { console.error(err); process.exit(1); });
