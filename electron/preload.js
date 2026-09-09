const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings:      () => ipcRenderer.invoke('get-settings'),
  saveSettings:     (settings) => ipcRenderer.invoke('save-settings', settings),
  checkForUpdates:  () => ipcRenderer.invoke('check-for-updates'),
  // Kept out of the settings store on purpose: everything in there is forwarded
  // to the listener as an env var, and the listener has no business knowing.
  getBetaUpdates:   () => ipcRenderer.invoke('updater:get-beta'),
  setBetaUpdates:   (on) => ipcRenderer.invoke('updater:set-beta', !!on),
  onUpdateStatus:   (callback) => ipcRenderer.on('update-status', (_, data) => callback(data)),
  // Twitch OAuth — handled entirely in main.js; no listener dependency
  startTwitchAuth:    () => ipcRenderer.invoke('twitch-auth-start', { flowType: 'broadcaster' }),
  startBotTwitchAuth: () => ipcRenderer.invoke('twitch-auth-start', { flowType: 'bot' }),
  onOAuthResult:    (callback) => ipcRenderer.on('oauth-result', (_, data) => callback(data)),
  // Detached chat panes ("docks"). Absent in standalone mode, which is why the
  // pane header checks for it before showing the button.
  detachPane:       (pane) => ipcRenderer.invoke('pane:detach', pane),
  setPaneAlwaysOnTop: (pane, value) => ipcRenderer.invoke('pane:set-always-on-top', { pane, value }),
  openDevTools:     () => ipcRenderer.invoke('open-devtools'),
  getDevMode:       () => ipcRenderer.invoke('get-dev-mode'),
  wipeSettings:     () => ipcRenderer.invoke('wipe-settings'),
  platform:         process.platform,
  // Recolours the OS-drawn Windows/Linux caption buttons to match the active
  // theme. No-op on macOS, where the traffic lights are not ours to colour.
  setTitleBarOverlay: (mode) => ipcRenderer.send('set-titlebar-overlay', { mode }),
});
