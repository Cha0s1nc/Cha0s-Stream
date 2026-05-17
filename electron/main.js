const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

// --- Dev mode: presence of a .debug file next to the exe (or project root in dev) unlocks the Dev tab ---
function getDebugFlagPath() {
  return app.isPackaged
    ? path.join(path.dirname(process.execPath), '.debug')
    : path.join(__dirname, '..', '.debug');
}
function isDevMode() {
  try { return fs.existsSync(getDebugFlagPath()); } catch { return false; }
}

// Configure auto-updater — manual download so user sees the popup first
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// electron-store schema — all keys optional strings with safe defaults.
// We keep previously-used keys in the schema so stored values don't cause
// validation errors on upgrade. Wrap construction so a corrupted store
// doesn't crash the main process.
const STORE_SCHEMA = {
  JELLYFIN_URL:             { type: 'string', default: '' },
  JELLYFIN_API_KEY:         { type: 'string', default: '' },
  JELLYFIN_USERNAME:        { type: 'string', default: '' },
  JELLYFIN_PASSWORD:        { type: 'string', default: '' },
  JELLYFIN_DEVICE_ID:       { type: 'string', default: '' },
  OBS_HOST:                 { type: 'string', default: 'localhost' },
  OBS_PORT:                 { type: 'string', default: '4455' },
  OBS_PASSWORD:             { type: 'string', default: '' },
  LISTENER_PORT:            { type: 'string', default: '3000' },
  TWITCH_USERNAME:          { type: 'string', default: '' },  // kept for backwards compat
  TWITCH_OAUTH:             { type: 'string', default: '' },
  TWITCH_CHANNEL:           { type: 'string', default: '' },
  TWITCH_CLIENT_ID:         { type: 'string', default: '' },
  TWITCH_BOT_USERNAME:      { type: 'string', default: '' },
  TWITCH_BOT_OAUTH:         { type: 'string', default: '' },
  TWITCH_CLIENT_SECRET:     { type: 'string', default: '' },
  SCRIPT_ALLOWLIST:         { type: 'string', default: '' },
  COMMANDS_CONFIG:          { type: 'string', default: '{}' },
  CUSTOM_COMMANDS:          { type: 'string', default: '{}' },
  REDEEM_ACTIONS:           { type: 'string', default: '{}' },
  MEDIA_CONTROL_MODE:       { type: 'string', default: 'jellyfin' },
  SONG_REQUEST_MODE:        { type: 'string', default: 'chat' },
  SONG_REQUEST_REDEEM_NAME: { type: 'string', default: '' },
  SONG_REQUEST_ENABLED:     { type: 'string', default: 'true' },
  MOD_ENABLED:              { type: 'string', default: 'true' },
  MOD_PORT:                 { type: 'string', default: '3001' },
  ALERT_MODE:               { type: 'string', default: 'browser_source' },
  ALERT_OBS_SOURCE:         { type: 'string', default: '' },
  ALERT_OBS_DURATION:       { type: 'string', default: '5000' },
};

let store;
try {
  store = new Store({ schema: STORE_SCHEMA });
} catch (err) {
  // Schema mismatch from a previous version — clear and start fresh
  console.error('Store schema error, clearing store:', err.message);
  const Store2 = require('electron-store');
  store = new Store2();
  store.clear();
  store = new Store2({ schema: STORE_SCHEMA });
}

let mainWindow;
let listenerProcess;
let updaterWindow = null;
let pendingUpdateInfo = null; // holds update-available info until window is ready

function getConfig() {
  return {
    JELLYFIN_URL: store.get('JELLYFIN_URL'),
    JELLYFIN_API_KEY: store.get('JELLYFIN_API_KEY'),
    JELLYFIN_USERNAME: store.get('JELLYFIN_USERNAME'),
    JELLYFIN_PASSWORD: store.get('JELLYFIN_PASSWORD'),
    JELLYFIN_DEVICE_ID: store.get('JELLYFIN_DEVICE_ID'),
    OBS_HOST: store.get('OBS_HOST'),
    OBS_PORT: store.get('OBS_PORT'),
    OBS_PASSWORD: store.get('OBS_PASSWORD'),
    LISTENER_PORT: store.get('LISTENER_PORT'),
    TWITCH_USERNAME: store.get('TWITCH_USERNAME'),
    TWITCH_OAUTH: store.get('TWITCH_OAUTH'),
    TWITCH_CHANNEL: store.get('TWITCH_CHANNEL'),
    TWITCH_CLIENT_ID: store.get('TWITCH_CLIENT_ID'),
    TWITCH_BOT_USERNAME: store.get('TWITCH_BOT_USERNAME'),
    TWITCH_BOT_OAUTH: store.get('TWITCH_BOT_OAUTH'),
    TWITCH_CLIENT_SECRET: store.get('TWITCH_CLIENT_SECRET'),
    SCRIPT_ALLOWLIST: store.get('SCRIPT_ALLOWLIST'),
    COMMANDS_CONFIG: store.get('COMMANDS_CONFIG'),
    CUSTOM_COMMANDS: store.get('CUSTOM_COMMANDS'),
    MEDIA_CONTROL_MODE: store.get('MEDIA_CONTROL_MODE'),
    SONG_REQUEST_MODE: store.get('SONG_REQUEST_MODE'),
    SONG_REQUEST_REDEEM_NAME: store.get('SONG_REQUEST_REDEEM_NAME'),
    SONG_REQUEST_ENABLED: store.get('SONG_REQUEST_ENABLED'),
    REDEEM_ACTIONS: store.get('REDEEM_ACTIONS'),
    MOD_ENABLED: store.get('MOD_ENABLED'),
    MOD_PORT: store.get('MOD_PORT'),
    ALERT_MODE: store.get('ALERT_MODE'),
    ALERT_OBS_SOURCE: store.get('ALERT_OBS_SOURCE'),
    ALERT_OBS_DURATION: store.get('ALERT_OBS_DURATION'),
  };
}

// --- Updater popup window ---
async function fetchReleaseNotes(version) {
  try {
    const res = await fetch('https://api.github.com/repos/Cha0s1nc/cha0s_listener/releases/latest', {
      headers: { 'User-Agent': 'cha0s-listener-updater' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { notes: data.body || '', date: data.published_at || '', url: data.html_url || '' };
  } catch {
    return null;
  }
}

function openUpdaterWindow(updateInfo) {
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    updaterWindow.focus();
    return;
  }

  updaterWindow = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 480,
    minHeight: 500,
    title: 'Update Available',
    backgroundColor: '#111113',
    autoHideMenuBar: true,
    resizable: true,
    parent: mainWindow || undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'updater-preload.js')
    }
  });

  updaterWindow.loadFile(path.join(__dirname, 'updater.html'));

  updaterWindow.webContents.once('did-finish-load', async () => {
    const release = await fetchReleaseNotes(updateInfo.version);
    updaterWindow.webContents.send('updater:init', {
      currentVersion: app.getVersion(),
      newVersion: updateInfo.version,
      releaseNotes: release?.notes || updateInfo.releaseNotes || '',
      releaseDate: release?.date || '',
      releaseUrl: release?.url || ''
    });
  });

  updaterWindow.on('closed', () => { updaterWindow = null; });
}

function startListener(config) {
  const listenerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'listener.js')
    : path.join(__dirname, '..', 'listener.js');

  if (listenerProcess) {
    listenerProcess.kill();
    listenerProcess = null;
  }

  try {
    listenerProcess = fork(listenerPath, [], {
      env: { ...process.env, ...config, DEV_MODE: isDevMode() ? 'true' : '' },
      silent: true
    });
  } catch (err) {
    console.error('Failed to fork listener:', err.message);
    return;
  }

  listenerProcess.stdout?.on('data', (data) => console.log('[listener]', data.toString().trim()));
  listenerProcess.stderr?.on('data', (data) => console.error('[listener error]', data.toString().trim()));
  listenerProcess.on('error', (err) => console.error('[listener fork error]', err.message));
  listenerProcess.on('exit', (code, signal) => {
    console.log(`Listener exited with code ${code} signal ${signal}`);
    // Auto-restart after 3s if it crashed (not a deliberate kill)
    if (code !== 0 && code !== null) {
      console.log('Listener crashed — restarting in 3s');
      setTimeout(() => startListener(getConfig()), 3000);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    title: 'Cha0s Listener',
    backgroundColor: '#111113',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  const port = store.get('LISTENER_PORT') || 3000;

  setTimeout(() => {
    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.show();
  }, 1500);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- Auto updater events ---
autoUpdater.on('checking-for-update', () => {
  console.log('[updater] Checking for update...');
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    updaterWindow.webContents.send('updater:log', 'Checking for update...');
  }
});

autoUpdater.on('update-available', (info) => {
  console.log(`[updater] Update available: v${info.version}`);
  pendingUpdateInfo = info;
  openUpdaterWindow(info);
});

autoUpdater.on('update-not-available', (info) => {
  console.log(`[updater] Up to date (v${info.version})`);
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    updaterWindow.webContents.send('updater:log', `Already on the latest version (v${info.version}).`);
  }
});

autoUpdater.on('download-progress', (progress) => {
  const percent    = Math.round(progress.percent);
  const mbps       = (progress.bytesPerSecond / 1024 / 1024).toFixed(2);
  const transferred = (progress.transferred / 1024 / 1024).toFixed(1);
  const total       = (progress.total / 1024 / 1024).toFixed(1);
  console.log(`[updater] Downloading: ${percent}% — ${transferred}/${total} MB @ ${mbps} MB/s`);

  if (updaterWindow && !updaterWindow.isDestroyed()) {
    updaterWindow.webContents.send('updater:progress', {
      percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
      logLine: `${percent}% — ${transferred} / ${total} MB  (${mbps} MB/s)`
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log(`[updater] Download complete: v${info.version}`);
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    updaterWindow.webContents.send('updater:done', { version: info.version });
  }
});

autoUpdater.on('error', (err) => {
  console.error('[updater] Error:', err.message);
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    updaterWindow.webContents.send('updater:error', { message: err.message });
  }
});

// IPC — renderer triggers an update check
ipcMain.handle('check-for-updates', () => {
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(err => console.error('[updater] Check error:', err.message));
  } else {
    // In dev: open the popup with fake data so UI can be tested
    openUpdaterWindow({ version: '99.0.0', releaseNotes: '### Dev test\n- This is a development preview of the updater UI.' });
  }
  return { ok: true };
});

// IPC — user clicked "Download Update"
ipcMain.handle('updater:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    if (updaterWindow && !updaterWindow.isDestroyed()) {
      updaterWindow.webContents.send('updater:error', { message: err.message });
    }
  }
  return { ok: true };
});

// IPC — user clicked "Restart & Install"
ipcMain.handle('updater:install', () => {
  autoUpdater.quitAndInstall();
});

// IPC — user dismissed the updater window
ipcMain.handle('updater:dismiss', () => {
  if (updaterWindow && !updaterWindow.isDestroyed()) updaterWindow.close();
});

// IPC — dev mode helpers (only meaningful when .debug file is present)
ipcMain.handle('open-devtools', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools();
});
ipcMain.handle('get-dev-mode', () => isDevMode());

// Twitch OAuth popup — opens an Electron BrowserWindow, intercepts the
// http://localhost redirect before the browser tries to load port 80,
// and returns the token directly without needing a callback server.
ipcMain.handle('twitch-oauth-popup', (event, { clientId, scopes }) => {
  return new Promise((resolve, reject) => {
    const authWin = new BrowserWindow({
      width: 600,
      height: 700,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'http://localhost',
      response_type: 'token',
      scope: scopes,
      force_verify: 'true'
    });

    authWin.loadURL(`https://id.twitch.tv/oauth2/authorize?${params}`);

    let settled = false;
    function settle(fn) {
      if (settled) return;
      settled = true;
      // Resolve/reject first, then destroy so the closed handler is a no-op
      fn();
      authWin.destroy();
    }

    function handleUrl(e, url) {
      if (!url.startsWith('http://localhost')) return false;
      e.preventDefault(); // stop the navigation from leaking to the system browser
      // Token lives in the fragment: http://localhost/#access_token=xxx&...
      const hashIndex = url.indexOf('#');
      if (hashIndex !== -1) {
        const fragment = url.slice(hashIndex + 1);
        const p = new URLSearchParams(fragment);
        const token = p.get('access_token');
        if (token) {
          settle(() => resolve({ token: `oauth:${token}` }));
          return true;
        }
      }
      // Error case: http://localhost/?error=access_denied&...
      try {
        const u = new URL(url);
        const err = u.searchParams.get('error');
        if (err) {
          settle(() => reject(new Error(u.searchParams.get('error_description') || err)));
          return true;
        }
      } catch {}
      return false;
    }

    authWin.webContents.on('will-redirect', (e, url) => { handleUrl(e, url); });
    authWin.webContents.on('will-navigate', (e, url) => { handleUrl(e, url); });
    authWin.on('closed', () => { if (!settled) { settled = true; reject(new Error('Cancelled')); } });
  });
});

ipcMain.handle('get-settings', () => getConfig());

ipcMain.handle('save-settings', (event, settings) => {
  for (const [key, value] of Object.entries(settings)) {
    store.set(key, value);
  }
  startListener(getConfig());
  return { ok: true };
});

app.whenReady().then(() => {
  startListener(getConfig());
  createWindow();

  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  }
});

app.on('window-all-closed', () => {
  if (listenerProcess) listenerProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (listenerProcess) listenerProcess.kill();
});
