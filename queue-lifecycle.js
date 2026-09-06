'use strict';

// Song requests retire when the player moves off them, not when they are
// approved. Approving only queues the track, so clearing there emptied the
// Requests panel while the song was still several tracks from being heard.
//
// Kept out of listener.js purely so it can be required by a test; listener.js
// is the entry point and starts listening the moment it is loaded.

/** Exact on id where both sides have one, otherwise the printed name. */
function trackMatchesEntry(track, entry) {
  const item = entry && entry.resolvedItem;
  if (!track || !item) return false;
  if (track.id && item.id) return String(track.id) === String(item.id);
  const norm = s => (s || '').trim().toLowerCase();
  if (!track.title || !item.name) return false;
  return norm(track.title) === norm(item.name) && norm(track.artist) === norm(item.artist);
}

/**
 * Given what is playing now and what was playing last tick, decide which
 * approved request (if any) is on screen and which one just finished.
 *
 * Pure: the caller does the splice and the broadcast. Returns
 * { playingId, retiredId } where either may be null.
 */
function reconcile(queue, track, prevPlayingId) {
  const playing = track && queue.find(e => e.status === 'approved' && trackMatchesEntry(track, e));
  if (playing) return { playingId: playing.id, retiredId: null };
  return { playingId: null, retiredId: prevPlayingId || null };
}

module.exports = { trackMatchesEntry, reconcile };
