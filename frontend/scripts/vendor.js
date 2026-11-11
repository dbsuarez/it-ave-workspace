// Copies third-party browser assets out of node_modules into src/vendor so the
// app never loads anything from node_modules at runtime. Run `npm run vendor`
// after upgrading socket.io-client or @fontsource/lato.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const copies = [
  ['node_modules/socket.io-client/dist/socket.io.min.js', 'src/vendor/socket.io.min.js'],
  ['node_modules/@fontsource/lato/files/lato-latin-400-normal.woff2', 'src/vendor/fonts/lato-latin-400-normal.woff2'],
  ['node_modules/@fontsource/lato/files/lato-latin-700-normal.woff2', 'src/vendor/fonts/lato-latin-700-normal.woff2'],
  ['node_modules/@fontsource/lato/files/lato-latin-900-normal.woff2', 'src/vendor/fonts/lato-latin-900-normal.woff2'],
  ['node_modules/@fontsource/lato/files/lato-latin-400-italic.woff2', 'src/vendor/fonts/lato-latin-400-italic.woff2'],
  ['node_modules/@fontsource/lato/LICENSE', 'src/vendor/fonts/LICENSE'],
];

for (const [from, to] of copies) {
  const target = path.join(root, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, from), target);
  console.log(`vendored ${to}`);
}
