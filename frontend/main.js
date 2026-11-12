const { app, BrowserWindow, ipcMain, dialog, Menu, session, shell, desktopCapturer, nativeImage, clipboard, Tray } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { normalizeServerUrl, resolveServerConfig } = require('./server-config');
const fs = require('fs');
const os = require('os');
const { isAllowedStoreKey, validateStoreWrite, isTrustedFrameUrl, validateExportRequest, exportFileName, EXPORT_FORMATS } = require('./ipc-policy');
const { buildPrintHtml } = require('./export/pdf-html');

// Notification sounds and calls must be able to play without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Create store for persisting auth token and settings
const store = new Store();

let mainWindow;
let loginWindow;
let tray = null;
let quitting = false;        // the app is really closing (Quit, or the system is shutting down)
let closeForReal = false;    // set while signing out, so the main window closes instead of hiding to the tray

// Closing the window hides the app to the system tray instead of quitting, so messages, mentions and calls
// keep arriving (and notify) while it is out of sight. Turn this off in Preferences.
function trayEnabled() {
  return store.get('closeToTray') !== false;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'src', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('IT Avenue Workspace');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open IT Avenue Workspace', click: () => { if (!showMainWindow() && store.get('authToken')) createWindow(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { if (!showMainWindow() && store.get('authToken')) createWindow(); });
}

// Only one copy of the app per profile: starting it again brings the running one forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { showMainWindow(); });
}

app.on('before-quit', () => { quitting = true; });

// Remove the native application menu entirely. All menu functions are exposed
// through the in-app hamburger menu instead.
Menu.setApplicationMenu(null);

// Links in messages open in the system browser. The app's own windows never
// navigate away from their local page or open child windows.
function confineNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    thickFrame: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep receiving messages and ringing while hidden in the tray
    },
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    title: 'IT Avenue Workspace',
    show: false,
  });

  mainWindow.setMenuBarVisibility(false);

  confineNavigation(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  ensureTray();

  mainWindow.on('close', (event) => {
    if (quitting || closeForReal || !trayEnabled()) return;
    event.preventDefault();
    mainWindow.hide();
    // once, say where the app went
    if (!store.get('trayHintShown') && tray && typeof tray.displayBalloon === 'function') {
      store.set('trayHintShown', true);
      tray.displayBalloon({ title: 'IT Avenue Workspace is still running', content: 'It stays in the system tray so you keep getting messages. Right-click the icon to quit.' });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return loginWindow;
  }

  loginWindow = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 440,
    minHeight: 640,
    resizable: false,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    title: 'IT Avenue Workspace - Login',
  });

  loginWindow.setMenuBarVisibility(false);

  confineNavigation(loginWindow);
  loginWindow.loadFile(path.join(__dirname, 'src', 'login.html'));

  loginWindow.on('closed', () => {
    loginWindow = null;
    // If the user just logged in, the token now exists - open the main window
    if (!mainWindow && store.get('authToken')) {
      createWindow();
    }
  });

  return loginWindow;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isMainApp = webContents === mainWindow?.webContents;
    // Huddles use the microphone and, when the user turns it on, the camera.
    const requestsMicOrCamera = permission === 'media'
      && details?.isMainFrame
      && Array.isArray(details.mediaTypes)
      && details.mediaTypes.length > 0
      && details.mediaTypes.every((type) => type === 'audio' || type === 'video');
    callback(isMainApp && (requestsMicOrCamera || permission === 'display-capture'));
  });

  // Screen sharing in a huddle shares the primary screen of this computer.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const fromMainApp = mainWindow && request.frame === mainWindow.webContents.mainFrame;
    if (!fromMainApp) {
      callback({});
      return;
    }
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback(sources.length ? { video: sources[0] } : {}))
      .catch((err) => {
        console.error('Screen capture source error:', err);
        callback({});
      });
  });

  // Check if we have a stored token
  const token = store.get('authToken');
  const user = store.get('user');

  if (token && user) {
    createWindow();
  } else {
    createLoginWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (store.get('authToken')) {
        createWindow();
      } else {
        createLoginWindow();
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ---- IPC ----
// Only the app's own pages (top-level frames loaded from ./src) may call the
// main process. Anything else is refused.
function isTrustedSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  return isTrustedFrameUrl(frame.url, __dirname);
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      console.warn(`Refused IPC "${channel}" from an untrusted sender`);
      throw new Error('This request is not allowed');
    }
    return handler(event, ...args);
  });
}

// The renderer can only read and write the few keys the app uses.
handleTrusted('store:get', (event, key) => {
  if (!isAllowedStoreKey(key)) return undefined;
  return store.get(key);
});

handleTrusted('store:set', (event, key, value) => {
  const problem = validateStoreWrite(key, value);
  if (problem) throw new Error(problem);
  store.set(key, value);
  return true;
});

handleTrusted('store:delete', (event, key) => {
  if (!isAllowedStoreKey(key)) throw new Error('That setting cannot be removed');
  store.delete(key);
  return true;
});

// Which server the app talks to. Read synchronously by the preload on every
// page load; changed only from the sign-in window.
function currentServerConfig() {
  return resolveServerConfig({ env: process.env, stored: store.get('serverUrl') });
}

ipcMain.on('config:get', (event) => {
  event.returnValue = isTrustedSender(event)
    ? currentServerConfig()
    : resolveServerConfig({});
});

function isLoginSender(event) {
  return Boolean(loginWindow && !loginWindow.isDestroyed() && event.sender === loginWindow.webContents);
}

// Validates an address and checks whether a backend answers there.
handleTrusted('config:checkServer', async (event, input) => {
  if (!isLoginSender(event)) return { ok: false, error: 'The server address can only be changed from the sign-in window' };
  let url;
  try {
    url = normalizeServerUrl(input);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(4000) });
    const body = await response.json().catch(() => ({}));
    return { ok: true, url, reachable: response.ok && body.status === 'ok' };
  } catch (err) {
    return { ok: true, url, reachable: false };
  }
});

handleTrusted('config:setServer', (event, input) => {
  if (!isLoginSender(event)) return { ok: false, error: 'The server address can only be changed from the sign-in window' };
  try {
    const url = normalizeServerUrl(input);
    store.set('serverUrl', url);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handleTrusted('config:resetServer', (event) => {
  if (!isLoginSender(event)) return { ok: false, error: 'The server address can only be changed from the sign-in window' };
  store.delete('serverUrl');
  return { ok: true };
});

handleTrusted('auth:logout', (event) => {
  store.delete('authToken');
  store.delete('user');
  closeForReal = true; // signing out closes the window for real

  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  createLoginWindow();
  setTimeout(() => {
    if (sourceWindow && !sourceWindow.isDestroyed()) sourceWindow.close();
    closeForReal = false;
  }, 0);
  return true;
});

// The "keep running in the tray" choice, and bringing the window back (from a notification, for example).
handleTrusted('tray:get', () => ({ enabled: trayEnabled() }));
handleTrusted('tray:set', (event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Expected true or false');
  store.set('closeToTray', enabled);
  return { enabled };
});
handleTrusted('app:showWindow', () => showMainWindow());

// Prints a self-contained HTML page to PDF in a hidden window with scripts off, no network and no access to
// the app's session.
async function printHtmlToPdf(html) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'itavenue-export-'));
  const file = path.join(dir, 'canvas.html');
  await fs.promises.writeFile(file, html, 'utf8');
  const exportSession = session.fromPartition(`export-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  exportSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/i.test(details.url) }));
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { session: exportSession, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await win.loadFile(file);
    return await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    win.destroy();
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// This installation's identity for attendance: a random id made once, and a readable name. It is sent with every
// clock-in and clock-out so HR can see when someone clocks in from a device they have not used before.
handleTrusted('device:get', () => {
  let id = store.get('deviceId');
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = require('crypto').randomUUID();
    store.set('deviceId', id);
  }
  return { id, name: `${require('os').hostname()} (${process.platform})` };
});

// Creating accounts from a spreadsheet: the person picks a .csv or .xlsx file, it is read here (never by the page)
// and only the rows go back. For automated tests only, IAV_TEST_IMPORT_FILE names the file and no dialog is shown.
handleTrusted('admin:importAccounts', async (event) => {
  let file = process.env.IAV_TEST_IMPORT_FILE;
  if (!file) {
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const chosen = await dialog.showOpenDialog(parent, {
      title: 'Choose a list of people',
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheet or CSV', extensions: ['csv', 'xlsx', 'txt'] }],
    });
    if (chosen.canceled || !chosen.filePaths.length) return { canceled: true };
    file = chosen.filePaths[0];
  }
  try {
    const { readAccountFile } = require('./accounts-import');
    return await readAccountFile(file);
  } catch (err) {
    return { accounts: [], notes: [err && err.message ? `Could not read that file: ${err.message}` : 'Could not read that file.'] };
  }
});

// Saving the new accounts' passwords (or a blank template) as a CSV the person chooses where to keep.
const CSV_SAVES = { credentials: 'new-accounts.csv', template: 'accounts-template.csv', employees: 'employees.csv', attendance: 'attendance-export.csv', leave: 'leave-records.csv' };
handleTrusted('admin:saveCsv', async (event, kind, created) => {
  if (!Object.prototype.hasOwnProperty.call(CSV_SAVES, kind)) throw new Error('Unknown file');
  const { credentialsCsv } = require('./accounts-import');
  let text;
  if (kind === 'employees' || kind === 'attendance' || kind === 'leave') {
    if (typeof created !== 'string' || created.length > 5 * 1024 * 1024) throw new Error('Invalid file contents');
    text = created;
  } else if (kind === 'template') {
    text = ['username,email,password,last name,first name,middle name', 'ann,ann@example.com,,Lee,Ann,Marie', 'bob,bob@example.com,,Cruz,Bob,', ''].join('\r\n');
  } else {
    if (!Array.isArray(created) || created.length > 500 || created.some((c) => !c || [c.username, c.email, c.password].some((v) => typeof v !== 'string'))) {
      throw new Error('Invalid file contents');
    }
    text = credentialsCsv(created);
  }
  let target;
  const testDir = process.env.IAV_TEST_EXPORT_DIR;
  if (testDir) {
    target = path.join(testDir, CSV_SAVES[kind]);
  } else {
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const chosen = await dialog.showSaveDialog(parent, {
      title: kind === 'credentials' ? 'Save the new accounts' : kind === 'employees' ? 'Save the employee list' : kind === 'attendance' ? 'Save the attendance export' : kind === 'leave' ? 'Save the leave records' : 'Save the template',
      defaultPath: path.join(app.getPath('documents'), CSV_SAVES[kind]),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (chosen.canceled || !chosen.filePath) return { canceled: true };
    target = chosen.filePath;
  }
  fs.writeFileSync(target, text, { encoding: 'utf8', mode: 0o600 });
  return { saved: true, path: target };
});

// Canvas export. The renderer sends the content; the user chooses the file in a save dialog (or, for
// automated tests only, IAV_TEST_EXPORT_DIR in the environment names a folder and no dialog is shown).
handleTrusted('canvas:export', async (event, request) => {
  const problem = validateExportRequest(request);
  if (problem) throw new Error(problem);
  const fileName = exportFileName(request.title, request.format);
  let target;
  const testDir = process.env.IAV_TEST_EXPORT_DIR;
  if (testDir) {
    target = path.join(testDir, fileName);
  } else {
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const chosen = await dialog.showSaveDialog(parent, {
      title: `Save as ${EXPORT_FORMATS[request.format]}`,
      defaultPath: path.join(app.getPath('documents'), fileName),
      filters: [{ name: EXPORT_FORMATS[request.format], extensions: [request.format] }],
    });
    if (chosen.canceled || !chosen.filePath) return { canceled: true };
    target = chosen.filePath;
  }
  let data;
  if (request.format === 'md') {
    data = Buffer.from(request.markdown, 'utf8');
  } else if (request.format === 'docx') {
    const { buildDocx } = require('./export/docx-builder');
    const images = {};
    for (const [id, picture] of Object.entries(request.images || {})) {
      images[id] = { data: Buffer.from(picture.base64, 'base64'), width: picture.width, height: picture.height };
    }
    data = await buildDocx({ title: request.title, doc: request.doc, images });
  } else {
    const html = buildPrintHtml({ title: request.title, bodyHtml: request.html });
    if (testDir) await fs.promises.writeFile(`${target}.html`, html, 'utf8');
    data = await printHtmlToPdf(html);
  }
  await fs.promises.writeFile(target, data);
  return { path: target };
});

handleTrusted('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    multiSelections: false,
  });
  return result.filePaths;
});

// App commands driven by the in-app menu
handleTrusted('app:command', (event, command) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return false;
  const contents = win.webContents;
  switch (command) {
    case 'reload':
      contents.reload();
      return true;
    case 'force-reload':
      contents.reloadIgnoringCache();
      return true;
    case 'devtools':
      contents.toggleDevTools();
      return true;
    case 'zoom-in':
      contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 5));
      return true;
    case 'zoom-out':
      contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3));
      return true;
    case 'zoom-reset':
      contents.setZoomLevel(0);
      return true;
    case 'fullscreen':
      win.setFullScreen(!win.isFullScreen());
      return true;
    case 'select-all':
      contents.selectAll();
      return true;
    case 'delete':
      contents.delete();
      return true;
    case 'undo':
      contents.undo();
      return true;
    case 'redo':
      contents.redo();
      return true;
    case 'cut':
      contents.cut();
      return true;
    case 'copy':
      contents.copy();
      return true;
    case 'paste':
      contents.paste();
      return true;
    case 'minimize':
      win.minimize();
      return true;
    case 'toggle-maximize':
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return true;
    case 'close-window':
      win.close();
      return true;
    case 'quit':
      app.quit();
      return true;
    case 'menu-state':
      return {
        applicationMenu: Menu.getApplicationMenu() === null ? null : 'present',
        menuBarVisible: win.isMenuBarVisible(),
        autoHideMenuBar: win.isMenuBarAutoHide(),
      };
    default:
      return false;
  }
});

// Copy an image (as a data: URL) to the system clipboard
handleTrusted('clipboard:copyImage', (event, dataUrl) => {
  try {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return { ok: false, error: 'Invalid image data' };
    }
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) {
      return { ok: false, error: 'Could not decode image data' };
    }
    clipboard.writeImage(image);
    return { ok: true };
  } catch (err) {
    console.error('Failed to copy image to clipboard:', err);
    return { ok: false, error: err.message || 'Copy failed' };
  }
});
