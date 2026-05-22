const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings:      () => ipcRenderer.invoke('get-settings'),
  saveSettings:     (settings) => ipcRenderer.invoke('save-settings', settings),
  checkForUpdates:  () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus:   (callback) => ipcRenderer.on('update-status', (_, data) => callback(data)),
  // Twitch OAuth — handled entirely in main.js; no listener dependency
  startTwitchAuth:    () => ipcRenderer.invoke('twitch-auth-start', { flowType: 'broadcaster' }),
  startBotTwitchAuth: () => ipcRenderer.invoke('twitch-auth-start', { flowType: 'bot' }),
  onOAuthResult:    (callback) => ipcRenderer.on('oauth-result', (_, data) => callback(data)),
  openDevTools:     () => ipcRenderer.invoke('open-devtools'),
  getDevMode:       () => ipcRenderer.invoke('get-dev-mode')
});
