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
});
