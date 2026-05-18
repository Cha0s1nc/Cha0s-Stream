const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const os     = require('os');
const { fork } = require('child_process');
const Store  = require('electron-store');

const GITHUB_REPO = 'Cha0s1nc/cha0s_listener';

// --- Dev mode: presence of a .debug file next to the exe (or project root in dev) unlocks the Dev tab ---
function getDebugFlagPath() {
  return app.isPackaged
    ? path.join(path.dirname(process.execPath), '.debug')
    : path.join(__dirname, '..', '.debug');
}
function isDevMode() {
  try { return fs.existsSync(getDebugFlagPath()); } catch { return false; }
}

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
  console.error('Store schema error, clearing store:', err.message);
  const Store2 = require('electron-store');
  store = new Store2();
  store.clear();
  store = new Store2({ schema: STORE_SCHEMA });
}

let mainWindow;
let listenerProcess;
let updaterWindow      = null;
let pendingDownload    = null; // { version, downloadUrl, assetName, releaseUrl, destPath }

function getConfig() {
  return {
    JELLYFIN_URL:             store.get('JELLYFIN_URL'),
    JELLYFIN_API_KEY:         store.get('JELLYFIN_API_KEY'),
    JELLYFIN_USERNAME:        store.get('JELLYFIN_USERNAME'),
    JELLYFIN_PASSWORD:        store.get('JELLYFIN_PASSWORD'),
    JELLYFIN_DEVICE_ID:       store.get('JELLYFIN_DEVICE_ID'),
    OBS_HOST:                 store.get('OBS_HOST'),
    OBS_PORT:                 store.get('OBS_PORT'),
    OBS_PASSWORD:             store.get('OBS_PASSWORD'),
    LISTENER_PORT:            store.get('LISTENER_PORT'),
    TWITCH_USERNAME:          store.get('TWITCH_USERNAME'),
    TWITCH_OAUTH:             store.get('TWITCH_OAUTH'),
    TWITCH_CHANNEL:           store.get('TWITCH_CHANNEL'),
    TWITCH_CLIENT_ID:         store.get('TWITCH_CLIENT_ID'),
    TWITCH_BOT_USERNAME:      store.get('TWITCH_BOT_USERNAME'),
    TWITCH_BOT_OAUTH:         store.get('TWITCH_BOT_OAUTH'),
    TWITCH_CLIENT_SECRET:     store.get('TWITCH_CLIENT_SECRET'),
    SCRIPT_ALLOWLIST:         store.get('SCRIPT_ALLOWLIST'),
    COMMANDS_CONFIG:          store.get('COMMANDS_CONFIG'),
    CUSTOM_COMMANDS:          store.get('CUSTOM_COMMANDS'),
    MEDIA_CONTROL_MODE:       store.get('MEDIA_CONTROL_MODE'),
    SONG_REQUEST_MODE:        store.get('SONG_REQUEST_MODE'),
    SONG_REQUEST_REDEEM_NAME: store.get('SONG_REQUEST_REDEEM_NAME'),
    SONG_REQUEST_ENABLED:     store.get('SONG_REQUEST_ENABLED'),
    REDEEM_ACTIONS:           store.get('REDEEM_ACTIONS'),
    MOD_ENABLED:              store.get('MOD_ENABLED'),
    MOD_PORT:                 store.get('MOD_PORT'),
    ALERT_MODE:               store.get('ALERT_MODE'),
    ALERT_OBS_SOURCE:         store.get('ALERT_OBS_SOURCE'),
    ALERT_OBS_DURATION:       store.get('ALERT_OBS_DURATION'),
  };
}

// ── Version helpers ────────────────────────────────────────────────────────────

function parseVersion(v) {
  return String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(latest, current) {
  const [la, lb, lc] = parseVersion(latest);
  const [ca, cb, cc] = parseVersion(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

// ── Updater popup window ───────────────────────────────────────────────────────

function openUpdaterWindow(updateInfo) {
  // Store download metadata for use in IPC handlers
  pendingDownload = {
    version:     updateInfo.version,
    downloadUrl: updateInfo.downloadUrl || null,
    assetName:   updateInfo.assetName   || 'cha0s-listener-setup.exe',
    releaseUrl:  updateInfo.releaseUrl  || '',
    destPath:    null,
  };

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

  updaterWindow.webContents.once('did-finish-load', () => {
    updaterWindow.webContents.send('updater:init', {
      currentVersion:    app.getVersion(),
      newVersion:        updateInfo.version,
      releaseNotes:      updateInfo.releaseNotes  || '',
      releaseDate:       updateInfo.releaseDate   || '',
      releaseUrl:        updateInfo.releaseUrl    || '',
      hasDirectDownload: !!updateInfo.downloadUrl,
    });
  });

  updaterWindow.on('closed', () => { updaterWindow = null; });
}

// ── GitHub release check ───────────────────────────────────────────────────────

async function checkForUpdates() {
  console.log('[updater] Checking for update...');
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    updaterWindow.webContents.send('updater:log', 'Checking for update...');
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'cha0s-listener-updater' }
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const release = await res.json();

    const latestVersion  = release.tag_name.replace(/^v/, '');
    const currentVersion = app.getVersion();

    if (!isNewer(latestVersion, currentVersion)) {
      console.log(`[updater] Up to date (v${currentVersion})`);
      if (updaterWindow && !updaterWindow.isDestroyed()) {
        updaterWindow.webContents.send('updater:log', `Already on the latest version (v${currentVersion}).`);
      }
      return;
    }

    console.log(`[updater] Update available: v${latestVersion}`);

    // Find the Windows installer asset (.exe)
    const asset = release.assets.find(a => /\.exe$/i.test(a.name));

    openUpdaterWindow({
      version:     latestVersion,
      releaseNotes: release.body          || '',
      releaseDate:  release.published_at  || '',
      releaseUrl:   release.html_url      || '',
      downloadUrl:  asset?.browser_download_url || null,
      assetName:    asset?.name           || 'cha0s-listener-setup.exe',
    });

  } catch (err) {
    console.error('[updater] Check failed:', err.message);
    if (updaterWindow && !updaterWindow.isDestroyed()) {
      updaterWindow.webContents.send('updater:error', { message: `Update check failed: ${err.message}` });
    }
  }
}

// ── File download (follows redirects, streams progress) ───────────────────────

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let lastBytes = 0;
    let lastTime  = Date.now();

    function request(url, redirects) {
      if (redirects > 10) { reject(new Error('Too many redirects')); return; }
      const lib = url.startsWith('https') ? https : http;
      lib.get(url, { headers: { 'User-Agent': 'cha0s-listener-updater' } }, (res) => {
        // Follow redirects (GitHub assets redirect to S3)
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          res.resume();
          request(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let transferred = 0;
        const file = fs.createWriteStream(destPath);

        res.on('data', chunk => {
          transferred += chunk.length;
          const now     = Date.now();
          const elapsed = (now - lastTime) / 1000;
          let bps = 0;
          if (elapsed >= 0.5) {
            bps       = (transferred - lastBytes) / elapsed;
            lastBytes = transferred;
            lastTime  = now;
          }
          if (onProgress) onProgress({ transferred, total, bytesPerSecond: bps });
        });

        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error',  err => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
        res.on('error',   err => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
      }).on('error', reject);
    }

    request(url, 0);
  });
}

// ── IPC — update check ─────────────────────────────────────────────────────────

ipcMain.handle('check-for-updates', () => {
  if (app.isPackaged) {
    checkForUpdates();
  } else {
    // Dev mode: open popup with fake data so the UI can be tested
    openUpdaterWindow({
      version:      '99.0.0',
      releaseNotes: '### Dev test\n- This is a development preview of the updater UI.\n- No actual download will occur.',
      releaseDate:  new Date().toISOString(),
      releaseUrl:   `https://github.com/${GITHUB_REPO}/releases`,
      downloadUrl:  null,
      assetName:    null,
    });
  }
  return { ok: true };
});

// IPC — user clicked "Download Update"
ipcMain.handle('updater:download', async () => {
  if (!pendingDownload) return { ok: false };

  // No direct asset found — fall back to opening the release page in the browser
  if (!pendingDownload.downloadUrl) {
    if (pendingDownload.releaseUrl) shell.openExternal(pendingDownload.releaseUrl);
    return { ok: true };
  }

  const destPath = path.join(os.tmpdir(), pendingDownload.assetName);

  try {
    if (updaterWindow && !updaterWindow.isDestroyed()) {
      updaterWindow.webContents.send('updater:log', `Downloading to ${destPath}...`);
    }

    await downloadFile(pendingDownload.downloadUrl, destPath, (progress) => {
      if (!updaterWindow || updaterWindow.isDestroyed()) return;
      const percent      = progress.total > 0 ? Math.round((progress.transferred / progress.total) * 100) : 0;
      const mbps         = (progress.bytesPerSecond / 1024 / 1024).toFixed(2);
      const transferred  = (progress.transferred / 1024 / 1024).toFixed(1);
      const total        = (progress.total / 1024 / 1024).toFixed(1);
      updaterWindow.webContents.send('updater:progress', {
        percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred:    progress.transferred,
        total:          progress.total,
        logLine:        `${percent}% — ${transferred} / ${total} MB  (${mbps} MB/s)`
      });
    });

    pendingDownload.destPath = destPath;
    console.log(`[updater] Download complete: ${destPath}`);

    if (updaterWindow && !updaterWindow.isDestroyed()) {
      updaterWindow.webContents.send('updater:done', { version: pendingDownload.version });
    }

  } catch (err) {
    console.error('[updater] Download failed:', err.message);
    if (updaterWindow && !updaterWindow.isDestroyed()) {
      updaterWindow.webContents.send('updater:error', { message: `Download failed: ${err.message}` });
    }
  }

  return { ok: true };
});

// IPC — user clicked "Restart & Install"
ipcMain.handle('updater:install', () => {
  if (pendingDownload?.destPath) {
    shell.openPath(pendingDownload.destPath).then(() => {
      setTimeout(() => app.quit(), 1500);
    });
  } else if (pendingDownload?.releaseUrl) {
    // Fallback: no downloaded file, just open the release page
    shell.openExternal(pendingDownload.releaseUrl);
  }
});

// IPC — user dismissed the updater window
ipcMain.handle('updater:dismiss', () => {
  if (updaterWindow && !updaterWindow.isDestroyed()) updaterWindow.close();
});

// ── Listener process ───────────────────────────────────────────────────────────

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

  listenerProcess.stdout?.on('data', d => console.log('[listener]', d.toString().trim()));
  listenerProcess.stderr?.on('data', d => console.error('[listener error]', d.toString().trim()));
  listenerProcess.on('error', err => console.error('[listener fork error]', err.message));
  listenerProcess.on('exit', (code, signal) => {
    console.log(`Listener exited with code ${code} signal ${signal}`);
    if (code !== 0 && code !== null) {
      console.log('Listener crashed — restarting in 3s');
      setTimeout(() => startListener(getConfig()), 3000);
    }
  });
}

// ── Main window ────────────────────────────────────────────────────────────────

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
  setTimeout(() => { mainWindow.loadURL(`http://localhost:${port}`); mainWindow.show(); }, 1500);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC — dev mode helpers ─────────────────────────────────────────────────────

ipcMain.handle('open-devtools', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools();
});
ipcMain.handle('get-dev-mode', () => isDevMode());

// ── IPC — Twitch OAuth popup ───────────────────────────────────────────────────
// Opens an Electron BrowserWindow, intercepts the http://localhost redirect
// before the browser tries to load port 80, and returns the token directly
// without needing a callback server.

ipcMain.handle('twitch-oauth-popup', (event, { clientId, scopes }) => {
  return new Promise((resolve, reject) => {
    const authWin = new BrowserWindow({
      width: 600,
      height: 700,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    const params = new URLSearchParams({
      client_id:    clientId,
      redirect_uri: 'http://localhost',
      response_type: 'token',
      scope:        scopes,
      force_verify: 'true'
    });

    authWin.loadURL(`https://id.twitch.tv/oauth2/authorize?${params}`);

    let settled = false;
    function settle(fn) {
      if (settled) return;
      settled = true;
      fn();
      authWin.destroy();
    }

    function handleUrl(e, url) {
      if (!url.startsWith('http://localhost')) return false;
      e.preventDefault();
      const hashIndex = url.indexOf('#');
      if (hashIndex !== -1) {
        const p     = new URLSearchParams(url.slice(hashIndex + 1));
        const token = p.get('access_token');
        if (token) { settle(() => resolve({ token: `oauth:${token}` })); return true; }
      }
      try {
        const u   = new URL(url);
        const err = u.searchParams.get('error');
        if (err) { settle(() => reject(new Error(u.searchParams.get('error_description') || err))); return true; }
      } catch {}
      return false;
    }

    authWin.webContents.on('will-redirect', (e, url) => { handleUrl(e, url); });
    authWin.webContents.on('will-navigate',  (e, url) => { handleUrl(e, url); });
    authWin.on('closed', () => { if (!settled) { settled = true; reject(new Error('Cancelled')); } });
  });
});

// ── IPC — settings ─────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => getConfig());

ipcMain.handle('save-settings', (event, settings) => {
  for (const [key, value] of Object.entries(settings)) {
    store.set(key, value);
  }
  startListener(getConfig());
  return { ok: true };
});

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  startListener(getConfig());
  createWindow();

  // Check for updates 5 seconds after launch (packaged builds only)
  if (app.isPackaged) {
    setTimeout(checkForUpdates, 5000);
  }
});

app.on('window-all-closed', () => {
  if (listenerProcess) listenerProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (listenerProcess) listenerProcess.kill();
});
