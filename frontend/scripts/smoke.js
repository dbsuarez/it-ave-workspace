// Starts the desktop app (from source, or a packaged build) and checks that its window really opens.
//
//   npm run smoke                                   the app from source
//   node scripts/smoke.js --exe "<path to .exe>"    a packaged build (for example dist/win-unpacked)
//
// It launches with a throwaway profile and a remote-debugging port, waits for the sign-in (or main) page to
// load, checks the page has a title, and closes the app. Exit code 0 means the app starts; 1 means it did not.
// No server is needed: without one the app simply shows its sign-in window.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 9555);
const WAIT_SECONDS = Number(process.env.SMOKE_WAIT || 45);
const root = path.join(__dirname, '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function pages() {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { resolve([]); } });
    }).on('error', () => resolve([])).on('timeout', function onTimeout() { this.destroy(); resolve([]); });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const exe = argValue('--exe');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'itavenue-smoke-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // otherwise Electron runs as plain Node and no window opens
  const flags = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu'];
  const command = exe || require('electron');
  const args = exe ? flags : [root, ...flags];
  if (exe && !fs.existsSync(exe)) { console.error(`Smoke test: ${exe} does not exist`); process.exit(1); }

  const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(-2000); });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  let found = null;
  for (let waited = 0; waited < WAIT_SECONDS && !found && exited === null; waited += 1) {
    await sleep(1000);
    found = (await pages()).find((page) => page.type === 'page' && /(login|index)\.html/.test(page.url));
  }

  const stop = () => {
    if (exited !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  };

  if (!found) {
    stop();
    console.error(`Smoke test FAILED: no app window within ${WAIT_SECONDS}s${exited !== null ? ` (the app exited with code ${exited})` : ''}.`);
    if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-8).join('\n'));
    process.exit(1);
  }
  const title = String(found.title || '').trim();
  stop();
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true });
  if (!title) { console.error('Smoke test FAILED: the window opened without a title (the page did not load).'); process.exit(1); }
  console.log(`Smoke test passed: "${title}" (${path.basename(found.url)}) opened${exe ? ` from ${path.basename(exe)}` : ''}.`);
}

main().catch((err) => { console.error('Smoke test FAILED:', err); process.exit(1); });
