const { contextBridge, ipcRenderer } = require('electron');

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

  // API configuration (set via environment variables in main process)
  apiBase: process.env.API_BASE || 'http://127.0.0.1:3001',
  socketUrl: process.env.SOCKET_URL || 'http://127.0.0.1:3001',
});
