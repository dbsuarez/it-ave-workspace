const { contextBridge, ipcRenderer } = require('electron');

// Which backend to talk to, resolved by the main process (environment variable,
// saved address, or the local default).
const serverConfig = ipcRenderer.sendSync('config:get') || {
  apiBase: 'http://127.0.0.1:3001', socketUrl: 'http://127.0.0.1:3001', source: 'default',
};

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Store operations
  storeGet: (key) => ipcRenderer.invoke('store:get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),
  storeDelete: (key) => ipcRenderer.invoke('store:delete', key),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // Build/runtime info
  isDev: process.env.IAV_DEV === '1',

  // App commands from the menu (reload, zoom, full screen)
  appCommand: (command) => ipcRenderer.invoke('app:command', command),

  // File dialog
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),

  // App info
  getAppVersion: () => process.versions.electron,

  // API configuration. `serverSource` is 'environment', 'saved' or 'default'.
  apiBase: serverConfig.apiBase,
  socketUrl: serverConfig.socketUrl,
  serverSource: serverConfig.source,
  // Server address changes (the main process only honours these from the sign-in window)
  checkServerUrl: (url) => ipcRenderer.invoke('config:checkServer', url),
  setServerUrl: (url) => ipcRenderer.invoke('config:setServer', url),
  resetServerUrl: () => ipcRenderer.invoke('config:resetServer'),

  // Keep running in the system tray when the window is closed, and bring the window back
  getTraySetting: () => ipcRenderer.invoke('tray:get'),
  setTraySetting: (enabled) => ipcRenderer.invoke('tray:set', enabled),
  showWindow: () => ipcRenderer.invoke('app:showWindow'),

  // Canvas export: PDF, Word or Markdown. The main process asks where to save it.
  exportCanvas: (request) => ipcRenderer.invoke('canvas:export', request),

  // Clipboard: copy an image (passed as a data: URL) to the system clipboard
  copyImageToClipboard: (dataUrl) => ipcRenderer.invoke('clipboard:copyImage', dataUrl),
});
