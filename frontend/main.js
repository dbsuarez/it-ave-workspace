const { app, BrowserWindow, ipcMain, dialog, Menu, session, shell, desktopCapturer, nativeImage, clipboard } = require('electron');
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

  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  createLoginWindow();
  setTimeout(() => {
    if (sourceWindow && !sourceWindow.isDestroyed()) sourceWindow.close();
  }, 0);
  return true;
});

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
