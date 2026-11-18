// Which third-party addresses may appear as text in the Sheets grid bundle (Jspreadsheet CE), and a scan that finds the others.
// Used by test/sheet-bundle.test.js and by scripts/check.js, so a new address fails the build until someone reviews it.
// The authoritative proof that the grid makes no outside request is the offline browser check done when the grid is built or upgraded.
const fs = require('fs');
const path = require('path');

const ALLOWED_HOSTS = {
  'www.w3.org': 'XML and SVG namespace identifiers inside the stylesheets, never fetched',
  'bossanova.uk': 'the library\'s home page: a link it can show and a version string; opening a link needs a click and goes to the system browser, nothing is fetched',
};

function findOutsideAddresses(vendorDir) {
  const files = [path.join(vendorDir, 'sheet-grid.js')];
  const assets = path.join(vendorDir, 'sheet-assets');
  if (fs.existsSync(assets)) for (const name of fs.readdirSync(assets)) files.push(path.join(assets, name));
  const backslash = String.fromCharCode(92);
  const stop = [backslash + 's', '"', "'", '`', ')', backslash + backslash].join('');
  const pattern = new RegExp('https?://([a-z0-9.-]+)[^' + stop + ']*', 'gi');
  const offenders = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      if (!ALLOWED_HOSTS[match[1].toLowerCase()]) offenders.push(`${path.relative(vendorDir, file)}: ${match[0].slice(0, 80)}`);
    }
  }
  return [...new Set(offenders)];
}

module.exports = { ALLOWED_HOSTS, findOutsideAddresses };
