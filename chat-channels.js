'use strict';

// Channel identity helpers for multi-channel chat. Pure, so they can be tested
// without standing up EventSub.

// True when a chat event came from our own room.
//
// Everything that acts on chat — commands, TTS, plugin events, command replies —
// must be gated on this. Guest channels are display-only: without the gate, a
// stranger typing !skip in someone else's chat drives this machine, and the
// reply lands in our room because sendChatMessage defaults there.
//
// Unknown home id means "treat as home". Messages cannot actually arrive before
// the id resolves (the subscription is created immediately after it is set), so
// this branch is unreachable in practice; it exists so a future code path that
// reorders those two steps degrades to today's single-channel behaviour rather
// than silently killing every command.
function isHomeChannel(eventBroadcasterId, homeBroadcasterId) {
  if (!homeBroadcasterId) return true;
  return String(eventBroadcasterId) === String(homeBroadcasterId);
}

// Twitch logins are 4-25 chars of [a-z0-9_], case-insensitive. People paste them
// with a leading # or a full channel URL, so accept both and hand back the login.
function normalizeLogin(input) {
  let s = String(input ?? '').trim().toLowerCase();
  s = s.replace(/^https?:\/\/(www\.)?twitch\.tv\//, '');
  s = s.replace(/^#/, '').replace(/[/?#].*$/, '');
  return /^[a-z0-9_]{4,25}$/.test(s) ? s : '';
}

// Normalizes a stored channel list: drops anything invalid, dedupes, and never
// includes the home channel. Home is implicit, so renaming TWITCH_CHANNEL cannot
// leave a stale duplicate tab behind.
function parseChannelList(raw, homeLogin) {
  let list;
  try {
    list = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const home = normalizeLogin(homeLogin);
  const out = [];
  for (const entry of list) {
    const login = normalizeLogin(entry);
    if (login && login !== home && !out.includes(login)) out.push(login);
  }
  return out;
}

module.exports = { isHomeChannel, normalizeLogin, parseChannelList };
