// Installs a downloaded macOS update in place: the new .app replaces the running
// one and relaunches, instead of leaving a DMG open to drag.
//
// Shared verbatim by Cascade and Cha0s Stream (electron/mac-update.js there).
// Nothing in it names either app, so keep the two copies byte-identical: change
// one, copy it to the other.
//
// Apple's own updater (Squirrel.Mac) refuses to apply updates to an app that is
// not signed with a Developer ID, and both apps are ad-hoc signed on purpose, so
// this does the same job by hand:
//
//   1. Mount the DMG out of sight and copy the new .app into a staging bundle
//      beside the installed one. Same directory, so the final swap is a
//      rename on one volume, not a copy that a quit could interrupt halfway.
//   2. Check the staged copy before touching anything: its signature verifies,
//      its bundle id is the app's own, and its version is the one being installed.
//   3. Hand off to a small shell script and quit. The script waits for this
//      process to exit, moves the old app aside, moves the new one into place,
//      deletes the old one and relaunches. If moving the new one in fails, it
//      puts the old app back, so a failed update never leaves no app at all.
//
// Anything that makes an in-place swap unsafe throws before step 3, and the
// caller falls back to opening the DMG as before: running from the DMG itself
// or from macOS's read-only App Translocation copy, a folder this account
// cannot write to, or a staged copy that fails its checks.
//
// What this does not do is re-run Gatekeeper. Files the app downloads itself
// are not quarantined, so macOS does not re-assess the new version; trust rests
// on the HTTPS download and the release digest main.js verifies before this
// runs. That catches corruption, not a malicious release uploaded to the repo.
//
// Semicolon-free, like Cascade's main.js. Stream's main.js uses semicolons; the
// file stays as it is there too, because identical beats locally consistent.

const { execFile, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) reject(new Error(`${path.basename(cmd)} failed: ${(stderr || err.message).trim()}`))
    else resolve(stdout.trim())
  })
})

// The script that performs the swap once the app has quit. Kept to POSIX sh and
// stock macOS tools. It gives up after a minute if the app never exits, leaving
// the installed app untouched.
const SWAP_SCRIPT = `#!/bin/sh
PID="$1"; TARGET="$2"; STAGED="$3"; BACKUP="$4"; LOG="$5"
exec >>"$LOG" 2>&1
echo "$(date) waiting for pid $PID to quit"
tries=0
while kill -0 "$PID" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then
    echo "gave up waiting; update not applied"
    rm -rf "$STAGED"
    exit 1
  fi
  sleep 0.2
done
rm -rf "$BACKUP"
if mv "$TARGET" "$BACKUP"; then
  if mv "$STAGED" "$TARGET"; then
    rm -rf "$BACKUP"
    echo "installed $TARGET"
  else
    echo "could not move the new app into place; restoring the old one"
    mv "$BACKUP" "$TARGET"
    rm -rf "$STAGED"
  fi
else
  echo "could not move the old app aside; update not applied"
  rm -rf "$STAGED"
fi
open "$TARGET"
`

/**
 * @param {object} o
 * @param {string} o.dmgPath         the downloaded, digest-verified DMG
 * @param {string} o.appBundle       the running app, e.g. /Applications/Name.app
 * @param {string} o.expectedVersion version the DMG must contain, e.g. "2.1.1"
 * @param {string} o.bundleId        the bundle id it must carry
 * @param {number} o.pid             the process the swap waits on
 * @param {(line: string) => void} [o.log]
 * @returns {Promise<{ logPath: string }>} once the swap script is running;
 *   the caller then quits the app.
 */
async function installInPlace({ dmgPath, appBundle, expectedVersion, bundleId, pid, log = () => {} }) {
  if (!appBundle.endsWith('.app')) throw new Error(`not running from an app bundle (${appBundle})`)
  const name = path.basename(appBundle, '.app')
  // For temp file names only: "Cha0s Stream" -> "cha0s-stream".
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  if (appBundle.includes('/AppTranslocation/')) {
    throw new Error(`${name} is running from a temporary copy macOS made; move it to Applications first`)
  }
  if (appBundle.startsWith('/Volumes/')) throw new Error(`${name} is running from a mounted disk image`)
  const parent = path.dirname(appBundle)
  try {
    fs.accessSync(parent, fs.constants.W_OK)
  } catch {
    throw new Error(`this account cannot write to ${parent}`)
  }

  const staged = path.join(parent, `.${name}-update-${expectedVersion}.app`)
  const backup = path.join(parent, `.${name}-previous.app`)
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), `${slug}-update-mount-`))

  fs.rmSync(staged, { recursive: true, force: true })
  try {
    log('Opening the downloaded update…')
    await run('/usr/bin/hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount])
    try {
      const found = fs.readdirSync(mount).filter(f => f.endsWith('.app'))
      if (found.length !== 1) throw new Error(`expected one app in the update, found ${found.length}`)
      log('Copying the new version…')
      // ditto keeps permissions, symlinks and extended attributes, all of which
      // a signed bundle depends on.
      await run('/usr/bin/ditto', [path.join(mount, found[0]), staged])
    } finally {
      await run('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => {})
      fs.rmSync(mount, { recursive: true, force: true })
    }

    log('Checking the new version…')
    await run('/usr/bin/codesign', ['--verify', '--strict', staged])
    const plist = path.join(staged, 'Contents', 'Info.plist')
    const gotId = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])
    const gotVersion = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])
    if (gotId !== bundleId) throw new Error(`update has bundle id ${gotId}, expected ${bundleId}`)
    if (gotVersion !== expectedVersion) throw new Error(`update contains version ${gotVersion}, expected ${expectedVersion}`)
  } catch (err) {
    fs.rmSync(staged, { recursive: true, force: true })
    throw err
  }

  const scriptPath = path.join(os.tmpdir(), `${slug}-update-${process.pid}.sh`)
  const logPath = path.join(os.tmpdir(), `${slug}-update.log`)
  fs.writeFileSync(scriptPath, SWAP_SCRIPT, { mode: 0o755 })
  const child = spawn('/bin/sh', [scriptPath, String(pid), appBundle, staged, backup, logPath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  log(`Installing v${expectedVersion} and restarting…`)
  return { logPath }
}

module.exports = { installInPlace }
