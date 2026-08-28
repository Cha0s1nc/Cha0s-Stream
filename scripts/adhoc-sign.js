// Ad-hoc sign the macOS bundle after packing.
//
// Why this exists: mac.identity is null so electron-builder never signs with
// the old self-signed cert (Gatekeeper treats an untrusted cert as a BROKEN
// signature - "app is damaged", no Open Anyway button - which is worse than
// not signing). But null means electron-builder skips signing *entirely*:
//
//   const qualifier = options.identity
//   if (qualifier === null) { log.info("skipped macOS code signing"); return false }
//
// That leaves only the ad-hoc signature Apple's linker puts on arm64 binaries,
// which has Identifier=Electron and covers no bundle resources. codesign
// rejects it with "code has no resources but signature indicates they must be
// present", and macOS calls the app damaged - the exact thing we were fixing.
//
// So sign it ourselves. Ad-hoc is enough to satisfy the arm64 requirement that
// all code carry a signature, and it puts the app in the "unidentified
// developer" bucket where users get an Open Anyway button.
//
// ponytail: --deep is deprecated by Apple but is correct enough for ad-hoc and
// avoids hand-walking every helper and framework. Switch to inside-out signing
// if a real Developer ID ever lands here, since --deep is wrong for that.

const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`  • ad-hoc signing ${app}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })

  // Verify rather than trust it. A silently invalid signature ships a DMG that
  // macOS refuses to open, and that failure is invisible until a user hits it.
  execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'inherit' })
  console.log('  • ad-hoc signature verified')
}
