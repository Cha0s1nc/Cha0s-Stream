'use strict';

// Run: npm test
//
// The PowerShell half can only run on Windows. What can run anywhere is everything
// that decides what the overlay sees: parsing, the art cache, and what gets handed
// to PowerShell.

const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../win-now-playing');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

test('a plain answer becomes a track with no art', () => {
  const s = w.createState();
  assert.deepEqual(w.ingest(s, '{"artist":"Velvet Antenna","title":"Neon Drift","playing":true}'),
    { title: 'Neon Drift', artist: 'Velvet Antenna', isPlaying: true, art: null });
});

// The old "Artist — Title" split broke when the dash arrived garbled. JSON has no
// separator to lose, and a dash inside a title is just part of the title.
test('a dash in the title is kept as the title', () => {
  const t = w.ingest(w.createState(), JSON.stringify({ artist: 'A', title: 'Intro — Reprise' }));
  assert.equal(t.title, 'Intro — Reprise');
  assert.equal(t.artist, 'A');
});

test('a thumbnail becomes a local art path, and the right content type', () => {
  const s = w.createState();
  const t = w.ingest(s, JSON.stringify({ artist: 'A', title: 'B', thumb: PNG, type: 'image/jpeg' }));
  assert.equal(t.art, '/api/art/os?v=1');
  assert.equal(s.type, 'image/jpeg');
  assert.deepEqual([...s.art], [0x89, 0x50, 0x4e, 0x47]);
});

test('a type that is not an image is not trusted', () => {
  const s = w.createState();
  w.ingest(s, JSON.stringify({ artist: 'A', title: 'B', thumb: PNG, type: 'text/html' }));
  assert.equal(s.type, 'image/png');
});

test('a new track drops the old art until its own arrives', () => {
  const s = w.createState();
  w.ingest(s, JSON.stringify({ artist: 'A', title: 'One', thumb: PNG }));
  const t = w.ingest(s, JSON.stringify({ artist: 'A', title: 'Two' }));
  assert.equal(t.art, null);
  assert.equal(s.art, null);
});

test('the same track keeps its art without re-reading it', () => {
  const s = w.createState();
  w.ingest(s, JSON.stringify({ artist: 'A', title: 'One', thumb: PNG }));
  const t = w.ingest(s, JSON.stringify({ artist: 'A', title: 'One' }));  // PowerShell skipped the read
  assert.equal(t.art, '/api/art/os?v=1');
});

// Some players set the title a moment before the art. Until art arrives, nothing
// is claimed as held, so PowerShell keeps trying.
test('PowerShell is only told to skip the read once art is actually held', () => {
  const s = w.createState();
  w.ingest(s, JSON.stringify({ artist: 'A', title: 'One' }));
  assert.equal(w.haveArtFor(s), '');
  w.ingest(s, JSON.stringify({ artist: 'A', title: 'One', thumb: PNG }));
  assert.equal(w.haveArtFor(s), 'A\nOne');
});

test('nothing playing, garbage, or an oversized image are all handled', () => {
  const s = w.createState();
  assert.equal(w.ingest(s, ''), null);
  assert.equal(w.ingest(s, 'not json'), null);
  assert.equal(w.ingest(s, '{"artist":"A"}'), null);
  const huge = Buffer.alloc(w.MAX_ART_BYTES + 1).toString('base64');
  const t = w.ingest(s, JSON.stringify({ artist: 'A', title: 'B', thumb: huge }));
  assert.equal(t.art, null);
});

test('PowerShell gets the script encoded, and the held key only through the environment', async () => {
  const s = w.createState();
  w.ingest(s, JSON.stringify({ artist: 'A', title: 'One', thumb: PNG }));

  let seen;
  const fakeExecFile = (cmd, args, opts, cb) => { seen = { cmd, args, opts }; cb(null, '{"artist":"A","title":"One"}'); };
  const t = await w.query(s, fakeExecFile);

  assert.equal(seen.cmd, 'powershell');
  const i = seen.args.indexOf('-EncodedCommand');
  assert.ok(i >= 0, 'script must go through -EncodedCommand');
  assert.equal(Buffer.from(seen.args[i + 1], 'base64').toString('utf16le'), w.SCRIPT);
  assert.equal(seen.opts.env.SD_HAVE_ART_FOR, 'A\nOne');
  // No title anywhere on the command line.
  assert.ok(!seen.args.some(a => a.includes('One')));
  assert.equal(t.art, '/api/art/os?v=1');
});
