const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updaterAPI', {
  download: ()  => ipcRenderer.invoke('updater:download'),
  install:  ()  => ipcRenderer.invoke('updater:install'),
  dismiss:  ()  => ipcRenderer.invoke('updater:dismiss'),

  onInit:     (cb) => ipcRenderer.on('updater:init',     (_, d) => cb(d)),
  onProgress: (cb) => ipcRenderer.on('updater:progress', (_, d) => cb(d)),
  onDone:     (cb) => ipcRenderer.on('updater:done',     (_, d) => cb(d)),
  onError:    (cb) => ipcRenderer.on('updater:error',    (_, d) => cb(d)),
  onLog:      (cb) => ipcRenderer.on('updater:log',      (_, d) => cb(d)),
});
