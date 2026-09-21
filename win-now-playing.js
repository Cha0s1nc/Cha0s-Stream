'use strict';

// What is playing on Windows, from the system media controls (the same source as
// the volume flyout's media box), including the album art.
//
// Two problems with how this used to work:
//   1. It asked PowerShell for "Artist — Title" and split on the dash. Windows
//      PowerShell does not write UTF-8 unless told to, so the dash could arrive as
//      mojibake, the split missed, and the whole line became the title.
//   2. It never read the thumbnail, so OS media mode on Windows showed no art at
//      all: the overlay fell back to its accent colour.
//
// Now PowerShell returns JSON, in UTF-8, and reads the thumbnail. Reading it costs
// a stream copy of a few hundred KB, so it only happens when the track changes (or
// until an app that sets its art a moment after its title gets there). The key of
// the track we already hold art for goes to PowerShell in an environment variable,
// never on the command line, so no title can ever be read as part of a command.
//
// Untested on Windows when written: the PowerShell half was written on a Mac and
// has not been run. ingest() and the caching around it are covered by
// test/win-now-playing.test.js; the script itself is what needs a Windows check.

const SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media,ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]',
  '$m = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()',
  '$s = $m.GetCurrentSession()',
  'if (-not $s) { exit }',
  '$p = $s.TryGetMediaPropertiesAsync().GetAwaiter().GetResult()',
  'if (-not $p -or -not $p.Title) { exit }',
  '$out = @{ artist = $p.Artist; title = $p.Title; playing = ($s.GetPlaybackInfo().PlaybackStatus.ToString() -eq "Playing") }',
  '$key = "$($p.Artist)`n$($p.Title)"',
  'if ($p.Thumbnail -and $key -ne $env:SD_HAVE_ART_FOR) {',
  '  try {',
  '    $st = $p.Thumbnail.OpenReadAsync().GetAwaiter().GetResult()',
  '    $n = [uint32]$st.Size',
  '    $r = [Windows.Storage.Streams.DataReader]::new($st)',
  '    $null = $r.LoadAsync($n).GetAwaiter().GetResult()',
  '    $b = New-Object byte[] $n',
  '    $r.ReadBytes($b)',
  '    $out.thumb = [Convert]::ToBase64String($b)',
  '    $out.type = $st.ContentType',
  '  } catch {}',
  '}',
  '$out | ConvertTo-Json -Compress',
].join('\n');

// PowerShell takes the script base64-encoded as UTF-16LE. Passing it through
// -Command instead means surviving Windows' command-line quoting, and this script
// has double quotes in it; -EncodedCommand has no quoting to get wrong.
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

// Art big enough to be a problem is not album art.
const MAX_ART_BYTES = 4 * 1024 * 1024;

function createState() {
  return { key: '', art: null, type: '', version: 0 };
}

/**
 * Fold one PowerShell answer into the state. Returns the track for the overlay,
 * or null when nothing is playing or the answer is not usable.
 */
function ingest(state, stdout) {
  let d;
  try { d = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  if (!d || typeof d !== 'object' || typeof d.title !== 'string' || !d.title) return null;

  const artist = typeof d.artist === 'string' ? d.artist : '';
  const key = `${artist}\n${d.title}`;
  if (key !== state.key) {
    state.key = key;
    state.art = null;          // the previous track's art must not linger
  }
  if (typeof d.thumb === 'string' && d.thumb) {
    const bytes = Buffer.from(d.thumb, 'base64');
    if (bytes.length && bytes.length <= MAX_ART_BYTES) {
      state.art = bytes;
      state.type = typeof d.type === 'string' && d.type.startsWith('image/') ? d.type : 'image/png';
      state.version++;
    }
  }

  return {
    title: d.title,
    artist,
    isPlaying: d.playing !== false,
    // Served by /api/art/os. The version busts the overlay's cache when it changes.
    art: state.art ? `/api/art/os?v=${state.version}` : null,
  };
}

/** Which track's art we already hold, so PowerShell can skip re-reading it. */
function haveArtFor(state) {
  return state.art ? state.key : '';
}

/** Run the query. Resolves to the overlay's track, or null. Windows only. */
function query(state, execFile = require('child_process').execFile) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
      env: { ...process.env, SD_HAVE_ART_FOR: haveArtFor(state) },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 8000,
      windowsHide: true,
    }, (err, stdout) => resolve(err ? null : ingest(state, stdout)));
  });
}

module.exports = { SCRIPT, createState, ingest, haveArtFor, query, MAX_ART_BYTES };
