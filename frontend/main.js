const { app, BrowserWindow, ipcMain, dialog, Menu, session, shell, desktopCapturer } = require('electron');
const path = require('path');
const Store = require('electron-store');

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

// IPC handlers
ipcMain.handle('store:get', (event, key) => {
  return store.get(key);
});

ipcMain.handle('store:set', (event, key, value) => {
  store.set(key, value);
  return true;
});

ipcMain.handle('store:delete', (event, key) => {
  store.delete(key);
  return true;
});

ipcMain.handle('auth:logout', (event) => {
  store.delete('authToken');
  store.delete('user');

  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  createLoginWindow();
  setTimeout(() => {
    if (sourceWindow && !sourceWindow.isDestroyed()) sourceWindow.close();
  }, 0);
  return true;
});

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    multiSelections: false,
  });
  return result.filePaths;
});

// App commands driven by the in-app menu
ipcMain.handle('app:command', (event, command) => {
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
