const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const os     = require('os');
const crypto = require('crypto');
const { fork, spawn } = require('child_process');
const Store  = require('electron-store');

const GITHUB_REPO = 'Cha0s1nc/cha0s-stream';

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
  CIDER_TOKEN:              { type: 'string', default: '' },
  SONG_REQUEST_MODE:        { type: 'string', default: 'chat' },
  SONG_REQUEST_REDEEM_NAME: { type: 'string', default: '' },
  SONG_REQUEST_ENABLED:     { type: 'string', default: 'true' },
  SONG_REQUEST_APPROVAL:    { type: 'string', default: 'approve' },
  SONG_REQUEST_FILTERS:     { type: 'string', default: '' },
  CIDER_STOREFRONT:         { type: 'string', default: 'us' },
  MOD_ENABLED:              { type: 'string', default: 'true' },
  MOD_PORT:                 { type: 'string', default: '3030' },
  MOD_TOKEN:                { type: 'string', default: '' },
  RELAY_ENABLED:            { type: 'string', default: '' },
  RELAY_URL:                { type: 'string', default: '' },
  RELAY_DEFER_COMMANDS:     { type: 'string', default: '' },
  ALERT_MODE:               { type: 'string', default: 'browser_source' },
  OVERLAYS_ENABLED:         { type: 'string', default: '' },
  NOWPLAYING_CONFIG:        { type: 'string', default: '' },
  ALERT_OBS_SOURCE:         { type: 'string', default: '' },
  ALERT_OBS_DURATION:       { type: 'string', default: '5000' },
  ALERT_CUSTOM_CONFIG:      { type: 'string', default: '' },
  CHAT_OVERLAY_CONFIG:      { type: 'string', default: '' },
  OVERLAY_MODE:             { type: 'string', default: '' },
  SEVENTV_ENABLED:          { type: 'string', default: '' },
  BTTV_ENABLED:             { type: 'string', default: '' },
  EVENT_TRIGGERS:           { type: 'string', default: '' },
  SPOTIFY_CLIENT_ID:        { type: 'string', default: '' },
  SPOTIFY_ACCESS_TOKEN:     { type: 'string', default: '' },
  SPOTIFY_REFRESH_TOKEN:    { type: 'string', default: '' },
  SPOTIFY_TOKEN_EXPIRY:     { type: 'string', default: '' },
  TTS_ENABLED:              { type: 'string', default: '' },
  TTS_VOICE:                { type: 'string', default: '' },
  TTS_RATE:                 { type: 'string', default: '' },
  TTS_CHAT_ENABLED:         { type: 'string', default: '' },
  TTS_CHAT_PERMISSION:      { type: 'string', default: '' },
  TTS_CHAT_SAY_NAME:        { type: 'string', default: '' },
  TTS_CHAT_MAX_LENGTH:      { type: 'string', default: '' },
  TTS_IGNORE_USERS:         { type: 'string', default: '' },
  TTS_NAME_ALIASES:         { type: 'string', default: '' },
  // Category master switches. Default 'true' so an upgrade changes nothing.
  COMMANDS_ENABLED:         { type: 'string', default: 'true' },
  MEDIA_ENABLED:            { type: 'string', default: 'true' },
  AUDIO_ENABLED:            { type: 'string', default: 'true' },
  // Its own key rather than OVERLAYS_ENABLED, which holds the JSON object of
  // per-overlay switches; writing 'false' over that wiped all three.
  OVERLAYS_MASTER_ENABLED:  { type: 'string', default: 'true' },
  TTS_BITS_THRESHOLD:       { type: 'string', default: '' },
  TTS_REDEMPTIONS_ENABLED:  { type: 'string', default: '' },
  TTS_REDEMPTION_NAMES:     { type: 'string', default: '' },
  TTS_ALERTS_ENABLED:       { type: 'string', default: '' },
  TTS_ALERT_TYPES:          { type: 'string', default: '' },
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
let crashStreak = 0;
let updaterWindow      = null;
let pendingDownload    = null; // { version, downloadUrl, assetName, releaseUrl, digest, destPath }

/**
 * The settings handed to the listener on start.
 *
 * Derived from STORE_SCHEMA rather than listed by hand. The two lists drifted:
 * a key added to one and not the other is either saved and never read back, or
 * read back and never saved, and both look to the user like a setting that will
 * not stick. The schema is the single source of truth now.
 */
function getConfig() {
  const config = {};
  for (const key of Object.keys(STORE_SCHEMA)) config[key] = store.get(key);
  return config;
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
    assetName:   updateInfo.assetName   || null,
    releaseUrl:  updateInfo.releaseUrl  || '',
    digest:      updateInfo.digest      || null,
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

// Which Linux package this install came from, so we hand back an update in the
// same format. AppImage announces itself through the environment; past that the
// distro's release file is the best available signal for deb vs rpm.
function linuxPackageKind() {
  if (process.env.APPIMAGE) return 'AppImage';
  // ponytail: a deb installed on an rpm distro (or vice versa) guesses wrong.
  // Read the app's owning package manager if that ever actually happens.
  if (fs.existsSync('/etc/debian_version')) return 'deb';
  if (fs.existsSync('/etc/redhat-release') || fs.existsSync('/etc/fedora-release')) return 'rpm';
  return null;
}

// Returns the asset matching this exact platform/arch/format, or undefined.
// Deliberately no "close enough" fallback: handing someone an installer that
// cannot run on their machine is worse than sending them to the releases page.
function pickAsset(assets = []) {
  const byExt = re => assets.filter(a => re.test(a.name));

  if (process.platform === 'win32') return byExt(/\.exe$/i)[0];

  // Apple Silicon only. An Intel Mac gets undefined and is sent to the release
  // page rather than handed a build it cannot run. The arm64 build carries its
  // arch in the filename, so the match stays explicit even though it is now the
  // only dmg published; older releases still have an unsuffixed x64 one.
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? byExt(/\.dmg$/i).find(a => /arm64/i.test(a.name)) : undefined;
  }

  if (process.platform === 'linux') {
    const kind = linuxPackageKind();
    if (kind === 'AppImage') return byExt(/\.AppImage$/i)[0];
    if (kind === 'deb')      return byExt(/\.deb$/i)[0];
    if (kind === 'rpm')      return byExt(/\.rpm$/i)[0];
  }

  return undefined;
}

async function checkForUpdates() {
  console.log('[updater] Checking for update...');
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    updaterWindow.webContents.send('updater:log', 'Checking for update...');
  }

  try {
    // Defaults on for a beta build itself (so it keeps finding newer betas), unless
    // the user has explicitly chosen otherwise, that choice always wins.
    const isBetaBuild = /-b\d*$/.test(app.getVersion());
    const betaUpdates = store.get('betaUpdates', isBetaBuild);

    let release;
    if (betaUpdates) {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`, {
        headers: { 'User-Agent': 'cha0s-stream-updater' }
      });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      const releases = await res.json();
      release = releases.find(r => !r.draft);
    } else {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'User-Agent': 'cha0s-stream-updater' }
      });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      release = await res.json();
    }

    if (!release) return { hasUpdate: false };

    const latestVersion  = release.tag_name.replace(/^v/, '');
    const currentVersion = app.getVersion();

    if (!isNewer(latestVersion, currentVersion)) {
      console.log(`[updater] Up to date (v${currentVersion})`);
      if (updaterWindow && !updaterWindow.isDestroyed()) {
        updaterWindow.webContents.send('updater:log', `Already on the latest version (v${currentVersion}).`);
      }
      return { hasUpdate: false };
    }

    console.log(`[updater] Update available: v${latestVersion}`);

    const asset = pickAsset(release.assets);

    openUpdaterWindow({
      version:      latestVersion,
      releaseNotes: release.body         || '',
      releaseDate:  release.published_at || '',
      releaseUrl:   release.html_url     || '',
      downloadUrl:  asset?.browser_download_url || null,
      assetName:    asset?.name          || null,
      digest:       asset?.digest        || null,
    });
    return { hasUpdate: true };

  } catch (err) {
    console.error('[updater] Check failed:', err.message);
    if (updaterWindow && !updaterWindow.isDestroyed()) {
      updaterWindow.webContents.send('updater:error', { message: `Update check failed: ${err.message}` });
    }
    return { hasUpdate: false, error: err.message };
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
      lib.get(url, { headers: { 'User-Agent': 'cha0s-stream-updater' } }, (res) => {
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

// GitHub populates a "sha256:<hex>" digest on release assets - verifying against
// it catches transit corruption/tampering. It does NOT prove the release itself
// wasn't malicious (the digest is computed from the same upload), so this is
// defense-in-depth, not a substitute for code signing.
function verifyDigest(filePath, digest) {
  return new Promise((resolve, reject) => {
    const [algo, expected] = digest.split(':');
    const hash = crypto.createHash(algo);
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex') === expected))
      .on('error', reject);
  });
}

// ── IPC — update check ─────────────────────────────────────────────────────────

ipcMain.handle('check-for-updates', async () => {
  if (app.isPackaged) {
    return await checkForUpdates();
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
    return { hasUpdate: true };
  }
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

    if (pendingDownload.digest) {
      const verified = await verifyDigest(destPath, pendingDownload.digest);
      if (!verified) {
        try { fs.unlinkSync(destPath); } catch {}
        throw new Error('Downloaded file failed integrity verification - it may have been corrupted or tampered with in transit');
      }
    }

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

// Windows can install itself. These are the flags electron-updater passes to an
// electron-builder NSIS installer: --updated marks it an upgrade rather than a
// fresh install, /S suppresses the wizard, --force-run relaunches us afterwards.
//
// /D pins the target directory. Without it a silent assisted installer (this one
// has allowToChangeInstallationDirectory) falls back to its default path rather
// than wherever the user actually installed, so an update can land beside the old
// copy instead of over it. NSIS requires /D last and unquoted, which is why it is
// built that way and not passed through a quoting helper.
function installSilentlyWindows(installerPath) {
  const args = ['--updated', '/S', '--force-run', `/D=${path.dirname(process.execPath)}`];
  const child = spawn(installerPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

// IPC — user clicked "Restart & Install"
ipcMain.handle('updater:install', () => {
  if (!pendingDownload?.destPath) {
    // No downloaded file (Linux packages, or no asset matched) — send them to the
    // release page rather than doing nothing.
    if (pendingDownload?.releaseUrl) shell.openExternal(pendingDownload.releaseUrl);
    return;
  }

  const handOver = () => shell.openPath(pendingDownload.destPath).then(() => {
    // macOS still needs the drag to Applications, so it stays open. Everything
    // else is handing off to an installer that has to replace a running binary.
    if (process.platform !== 'darwin') setTimeout(() => app.quit(), 1500);
  });

  if (process.platform !== 'win32') return handOver();

  try {
    let quitTimer = null;
    const child = installSilentlyWindows(pendingDownload.destPath);
    // spawn reports a missing or unrunnable installer asynchronously, so the
    // quit waits long enough to hear about it. Quitting first would leave the
    // user with no app and no installer.
    child.on('error', (err) => {
      console.error('[updater] Silent install failed, opening the installer:', err.message);
      clearTimeout(quitTimer);
      handOver();
    });
    quitTimer = setTimeout(() => app.quit(), 1000);
  } catch (err) {
    console.error('[updater] Silent install failed, opening the installer:', err.message);
    handOver();
  }
});

// IPC — beta channel opt-in. Defaults to on for a build that is itself a beta,
// so a beta never strands its user on a channel it cannot see updates for.
ipcMain.handle('updater:get-beta', () => store.get('betaUpdates', /-b\d*$/.test(app.getVersion())));
ipcMain.handle('updater:set-beta', (_e, on) => { store.set('betaUpdates', !!on); return { ok: true }; });

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
    listenerProcess.expectedExit = true;
    listenerProcess.kill();
    listenerProcess = null;
  }

  // In packaged builds, listener.js runs from inside the read-only app.asar.
  // Any path derived from __dirname there (sounds, plugins, .env) will point
  // inside the archive and fail on write.  Redirect writable paths to userData.
  const extraEnv = app.isPackaged ? (() => {
    const userData = app.getPath('userData');
    return {
      SOUNDS_DIR:          path.join(userData, 'sounds'),
      PLUGINS_DIR:         path.join(userData, 'plugins'),
      PLUGIN_STORE_PATH:   path.join(userData, 'plugin-store.json'),
      DOTENV_CONFIG_PATH:  path.join(userData, '.env'),
      SEVENTV_CACHE_FILE:  path.join(userData, 'emote-cache.json'),
    };
  })() : {};

  try {
    listenerProcess = fork(listenerPath, [], {
      env: { ...process.env, ...config, DEV_MODE: isDevMode() ? 'true' : '', ELECTRON_MODE: 'true', ...extraEnv },
      silent: true
    });
  } catch (err) {
    console.error('Failed to fork listener:', err.message);
    return;
  }

  // The listener owns settings the dashboard saves through its own endpoints -
  // alert config, chat overlay config, triggers, commands. It used to persist
  // those to a .env file beside itself, which in a packaged build is inside
  // app.asar and read-only, and which this process overwrites from the store on
  // the next restart anyway. It reports them here instead.
  //
  // Deliberately no restart: the listener already has these values, that is
  // where they came from. Restarting would drop every websocket for nothing.
  listenerProcess.on('message', (msg) => {
    if (!msg || msg.type !== 'persist' || !msg.patch) return;
    let n = 0;
    for (const [key, value] of Object.entries(msg.patch)) {
      if (!(key in STORE_SCHEMA)) continue;          // schema is the allowlist
      if (store.get(key) === value) continue;
      store.set(key, value);
      n++;
    }
    if (n) console.log(`[stream] persisted ${n} setting(s) from the listener`);
  });

  listenerProcess.stdout?.on('data', d => console.log('[listener]', d.toString().trim()));
  listenerProcess.stderr?.on('data', d => console.error('[listener error]', d.toString().trim()));
  listenerProcess.on('error', err => console.error('[listener fork error]', err.message));
  const child = listenerProcess;
  const startedAt = Date.now();
  child.on('exit', (code, signal) => {
    console.log(`Listener exited with code ${code} signal ${signal}`);
    // A signal death reports code null, and this used to skip the restart for
    // exactly that case: SIGSEGV in a native module, or the OOM killer, left the
    // window open and looking healthy with the whole backend gone. Nothing
    // served :3000, no Twitch, no relay, no overlays, and no indication why.
    // Only an exit we asked for is not a crash, so track that instead of
    // guessing from the exit code.
    if (child.expectedExit) return;
    if (code === 0) return;

    // Widening the restart to signals means a listener that segfaults on startup
    // would respawn every 3s forever. Count only the fast failures: a crash after
    // a long healthy run resets the streak.
    crashStreak = Date.now() - startedAt < 10000 ? crashStreak + 1 : 0;
    if (crashStreak >= 5) {
      console.error('Listener crashed 5 times in a row on startup - not restarting again.');
      return;
    }
    console.log('Listener crashed - restarting in 3s');
    setTimeout(() => startListener(getConfig()), 3000);
  });
}

// ── Main window ────────────────────────────────────────────────────────────────

// The app's own header strip is 38px (public/index.html) - the Window Controls
// Overlay height must match it or the OS-drawn buttons sit off-centre.
const TITLEBAR_HEIGHT = 38;

// Matches --surface/--text from index.html's :root and its light theme block.
function titleBarOverlayColors(mode) {
  return mode === 'light'
    ? { color: '#ffffff', symbolColor: '#1c1c1e' }
    : { color: '#1c1c1e', symbolColor: '#f5f5f7' };
}

/** titleBarOverlay options for win32/linux, or nothing at all if building them
 *  fails. Degrading to no overlay costs the OS caption buttons; throwing here
 *  costs the entire window. */
function overlayOptions() {
  try {
    return { titleBarOverlay: { ...titleBarOverlayColors('dark'), height: TITLEBAR_HEIGHT } };
  } catch (e) {
    console.error('[stream] titleBarOverlay unavailable, falling back to a plain hidden titlebar:', e);
    return {};
  }
}

// The renderer owns the theme (it lives in localStorage, not the store), so it
// recolours the caption buttons itself once applyTheme() has run.
ipcMain.on('set-titlebar-overlay', (_e, { mode }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.setTitleBarOverlay(titleBarOverlayColors(mode)); } catch {}
});

function createWindow() {
  const isDarwin = process.platform === 'darwin';
  const base = {
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    title: 'Cha0s Stream',
    backgroundColor: '#111113',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  };

  // Without frameless chrome the OS title bar is drawn ABOVE the app's own 38px
  // header, stacking two title bars. hiddenInset is macOS-only and is silently
  // ignored elsewhere, so Windows/Linux get 'hidden' plus titleBarOverlay.
  //
  // The try/catch is around the CONSTRUCTOR, not around building the options.
  // Building a plain object cannot fail; it is BrowserWindow that rejects an
  // overlay config it dislikes, and a throw here leaves mainWindow undefined and
  // no window on screen at all. Falling back to the OS title bar means the two
  // bars stack again, which is ugly - but an ugly window beats an absent one,
  // and a frameless window with no caption buttons could not even be closed.
  const chrome = isDarwin
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 11 } }
    : { titleBarStyle: 'hidden', ...overlayOptions() };
  try {
    mainWindow = new BrowserWindow({ ...base, ...chrome });
  } catch (err) {
    console.error('[stream] frameless titlebar rejected, using the OS one:', err);
    mainWindow = new BrowserWindow(base);
  }

  const port = store.get('LISTENER_PORT') || 3000;

  let shown = false;
  const show = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
  };
  // Deliberately not hung off 'ready-to-show': on Windows it can simply never
  // fire. The window paints as backgroundColor until the page arrives, so
  // showing it early costs a moment of empty dark rather than a white flash.
  setTimeout(show, 900);
  mainWindow.webContents.once('did-finish-load', show);

  // Poll the port rather than letting loadURL fail. The listener is a forked
  // child that is often not accepting connections yet; navigating anyway paints
  // Chromium's connection-error page, which is what the old blind 1500ms timer
  // left on screen permanently.
  const deadline = Date.now() + 60000;
  let navigated = false;
  const goLive = () => {
    if (navigated || !mainWindow || mainWindow.isDestroyed()) return;
    navigated = true;
    mainWindow.loadURL(`http://localhost:${port}`).catch(() => {});
  };
  const poll = () => {
    if (navigated || !mainWindow || mainWindow.isDestroyed()) return;
    let settled = false;
    const retry = () => {
      if (settled) return;
      settled = true;
      // After a minute the listener is not merely slow. Navigate anyway so the
      // error page at least says something instead of showing empty dark.
      if (Date.now() > deadline) return goLive();
      setTimeout(poll, 300);
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1200 }, (res) => {
      res.resume();
      if (settled) return;
      settled = true;
      goLive();
    });
    req.on('timeout', () => { req.destroy(); retry(); });
    req.on('error', retry);
  };
  poll();

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC — dev mode helpers ─────────────────────────────────────────────────────

ipcMain.handle('open-devtools', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools();
});
ipcMain.handle('get-dev-mode', () => isDevMode());

// ── Twitch OAuth (implicit grant, system browser, main-process owned) ─────────
// Runs entirely in main.js so it survives listener restarts.
// Spins up a one-time HTTP server on port 3773 per-auth-attempt, reads the token
// out of the URL fragment (see the note at response_type below), fetches the
// username, saves to the store, restarts the listener, and sends the result
// straight to the renderer via webContents.send.
// The standalone listener uses PKCE instead; this path does not.

const BUILTIN_CLIENT_ID   = '3u4lr8zav4saitil8q3fhrydcstta6';
const OAUTH_CALLBACK_PORT = 3773;
const TWITCH_SCOPES = [
  'user:read:chat', 'user:write:chat', 'channel:bot',
  'channel:read:redemptions', 'user:read:whispers', 'whispers:read',
  'moderator:read:chat_messages', 'moderator:read:followers',
  'bits:read', 'channel:read:subscriptions'
].join(' ');
const TWITCH_BOT_SCOPES = 'user:write:chat';

function startTwitchOAuth(flowType) {
  return new Promise((resolve, reject) => {
    const customClientId = store.get('TWITCH_CLIENT_ID') || '';
    const clientId       = customClientId || BUILTIN_CLIENT_ID;
    const redirectUri    = `http://localhost:${OAUTH_CALLBACK_PORT}/twitch/auth/callback`;
    const stateToken     = require('crypto').randomBytes(16).toString('hex');
    const scopes         = flowType === 'bot' ? TWITCH_BOT_SCOPES : TWITCH_SCOPES;

    // Use implicit grant flow (response_type=token) — no client_secret or PKCE exchange needed.
    // Twitch returns the token in the URL fragment; we serve a tiny JS page that extracts it
    // and forwards it to /twitch/auth/complete as a query param.
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri,
      response_type: 'token', scope: scopes, state: stateToken,
      force_verify: 'true'
    });

    let settled = false;
    let timeoutHandle = null;
    let server = null;

    function cleanup() {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try { server?.close(); } catch {}
    }
    function settle(fn) {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    }

    const pageStyle = `<style>
      body{font-family:-apple-system,sans-serif;background:#111113;color:#f5f5f7;
           display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .card{background:#1c1c1e;border:1px solid #3a3a3c;border-radius:12px;
            padding:28px 36px;text-align:center;max-width:420px}
      h2{margin:0 0 8px;font-size:18px}p{margin:0;font-size:13px;color:#aeaeb2}
    </style>`;
    const page = (icon, title, msg) =>
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Cha0s Stream</title>${pageStyle}</head>
       <body><div class="card"><div style="font-size:32px">${icon}</div>
       <h2>${title}</h2><p>${msg}</p></div></body></html>`;

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${OAUTH_CALLBACK_PORT}`);

      // Step 1 — Twitch lands here with the token in the URL fragment (#access_token=...).
      // Fragments are not sent to the server, so serve a tiny page that reads the hash
      // and redirects to /twitch/auth/complete with the token as a query param.
      if (url.pathname === '/twitch/auth/callback') {
        const error = url.searchParams.get('error');
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(page('❌', 'Authorization cancelled', error));
          return settle(() => reject(new Error(error)));
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8">
          <title>Cha0s Stream — Connecting…</title>${pageStyle}</head><body>
          <div class="card"><h2>Connecting…</h2><p>Please wait.</p></div>
          <script>
            const h = window.location.hash.substring(1);
            const p = new URLSearchParams(h);
            const token = p.get('access_token');
            const state = p.get('state');
            if (token) {
              fetch('/twitch/auth/complete?access_token=' + encodeURIComponent(token)
                + '&state=' + encodeURIComponent(state || ''))
                .then(r => r.text()).then(html => { document.body.innerHTML = html; });
            } else {
              document.querySelector('.card p').textContent = 'No token in response. Please try again.';
            }
          </script></body></html>`);
        return;
      }

      // Step 2 — JS page POSTed the token here as a query param.
      if (url.pathname === '/twitch/auth/complete') {
        const token = url.searchParams.get('access_token');
        const state = url.searchParams.get('state');

        if (!token || state !== stateToken) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(page('❌', 'Invalid request', 'State mismatch or missing token. Please try again.').replace('<body>', '<body>').replace('</body>', '</body>'));
          return settle(() => reject(new Error('Invalid callback')));
        }

        let username = '';
        try {
          const ur = await fetch('https://api.twitch.tv/helix/users', {
            headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId }
          });
          if (ur.ok) { const ud = await ur.json(); username = ud.data?.[0]?.login || ''; }
        } catch {}

        const successHtml = page('✅', flowType === 'bot' ? 'Bot authorized!' : 'Authorized!',
          `Logged in as <strong>${username || 'unknown'}</strong>. You can close this tab.`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(successHtml);
        settle(() => resolve({ token: `oauth:${token}`, username }));
        return;
      }

      res.writeHead(404); res.end();
    });

    server.listen(OAUTH_CALLBACK_PORT, () => {
      console.log(`[oauth] Callback server listening on port ${OAUTH_CALLBACK_PORT}`);
      shell.openExternal(`https://id.twitch.tv/oauth2/authorize?${params}`);
    });

    server.on('error', (err) => {
      settle(() => reject(new Error(`Auth server error (port ${OAUTH_CALLBACK_PORT}): ${err.message}`)));
    });

    timeoutHandle = setTimeout(() => {
      settle(() => reject(new Error('Authorization timed out after 10 minutes')));
    }, 600000);
  });
}

ipcMain.handle('twitch-auth-start', async (event, { flowType = 'broadcaster' } = {}) => {
  try {
    const { token, username } = await startTwitchOAuth(flowType);
    if (flowType === 'bot') {
      store.set('TWITCH_BOT_OAUTH', token);
      if (username) store.set('TWITCH_BOT_USERNAME', username);
    } else {
      store.set('TWITCH_OAUTH', token);
      if (username) store.set('TWITCH_CHANNEL', username);
    }
    startListener(getConfig());
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('oauth-result', { flowType, token, username, ok: true });
    }
    return { ok: true, token, username };
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('oauth-result', { flowType, ok: false, error: err.message });
    }
    return { ok: false, error: err.message };
  }
});

// ── IPC — settings ─────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => getConfig());

ipcMain.handle('wipe-settings', () => {
  store.clear();
  startListener(getConfig());
  return { ok: true };
});

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
  if (listenerProcess) { listenerProcess.expectedExit = true; listenerProcess.kill(); }
  app.quit();
});

app.on('before-quit', () => {
  if (listenerProcess) { listenerProcess.expectedExit = true; listenerProcess.kill(); }
});
