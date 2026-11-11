// After `npm run dist`: reports whether the Windows installer (and the app inside it) is code-signed.
//
//   npm run verify:installer
//
// An unsigned installer works but shows Windows SmartScreen's "unknown publisher" warning. To sign, buy a
// code-signing certificate and give electron-builder its file and password before building:
//   $env:CSC_LINK = "C:\path\to\certificate.pfx"; $env:CSC_KEY_PASSWORD = "..."; npm run dist
// (see deploy/README.md). Exit code 0 = signed and valid; 1 = missing or not signed (so CI can require it).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const targets = fs.existsSync(dist)
  ? fs.readdirSync(dist).filter((name) => /Setup .*\.exe$/i.test(name)).map((name) => path.join(dist, name))
  : [];
const unpacked = path.join(dist, 'win-unpacked', 'IT Avenue Workspace.exe');
if (fs.existsSync(unpacked)) targets.push(unpacked);

if (process.platform !== 'win32') {
  console.error('verify-installer only checks Windows builds (it uses Get-AuthenticodeSignature).');
  process.exit(1);
}
if (!targets.length) {
  console.error('No installer found in dist/. Run `npm run dist` first.');
  process.exit(1);
}

let allSigned = true;
for (const file of targets) {
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)|$($s.TimeStamperCertificate.Subject)"`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  const [status, signer, stamp] = String(result.stdout || '').trim().split('|');
  const signed = status === 'Valid';
  if (!signed) allSigned = false;
  console.log(`${signed ? 'SIGNED  ' : 'UNSIGNED'} ${path.relative(path.join(__dirname, '..'), file)}  [${status}]${signer ? `  signer: ${signer}` : ''}${stamp ? `  timestamp: ${stamp}` : ''}`);
}
if (!allSigned) console.error('\nNot signed (or the signature is not valid). See the notes at the top of this script.');
process.exit(allSigned ? 0 : 1);
