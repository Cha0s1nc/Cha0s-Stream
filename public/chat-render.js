'use strict';

// Shared chat rendering for the dashboard stream panel (index.html), the OBS
// chat overlay (chat.html), and detached panes. Plain <script src> on purpose:
// there is no build step in this project, and staying in global scope keeps the
// inline onclick handlers in index.html working.
//
// Everything here is pure — the emote map and badge cache come in as arguments
// rather than closed-over globals, which is what lets one page render several
// channels with different emote sets at once.
//
// ponytail: the .chat-* CSS stays duplicated in index.html and chat.html. Same
// class names, deliberately different scales (emote 1.4em vs 1.8em), and the
// overlay's are runtime-overridden by applyConfig(). A shared sheet would need
// overrides in both files, which is more code than the duplication.

// Escapes the five characters that matter inside both text and attributes.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Deterministic fallback colour for users who never picked one.
const FALLBACK_COLOURS = ['#ff6b6b','#ff9f40','#ffd60a','#4ade80','#22d3ee','#818cf8','#e879f9','#fb7185'];

function nameToColour(name) {
  const s = String(name ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return FALLBACK_COLOURS[Math.abs(h) % FALLBACK_COLOURS.length];
}

// Third-party emotes are matched whole-word only, which is how Twitch, 7TV and
// BTTV all behave — substring matching would rewrite the middle of URLs.
function renderWords(text, emotes) {
  return String(text ?? '').split(' ').map(word => {
    const url = emotes && emotes[word];
    return url
      ? `<img class="chat-emote" src="${esc(url)}" alt="${esc(word)}" title="${esc(word)}">`
      : esc(word);
  }).join(' ');
}

function renderFragment(fragment, emotes) {
  // Twitch native emote — the server hands us the id, we build the CDN url.
  if (fragment.type === 'emote' && fragment.emoteId) {
    const url = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(fragment.emoteId)}/default/dark/2.0`;
    return `<img class="chat-emote" src="${url}" alt="${esc(fragment.text)}" title="${esc(fragment.text)}">`;
  }
  return renderWords(fragment.text, emotes);
}

function renderBody(data, emotes) {
  if (data.fragments && data.fragments.length > 0) {
    return data.fragments.map(f => renderFragment(f, emotes)).join('');
  }
  // No fragments (a replayed or synthetic message): scan the raw text instead.
  return renderWords(data.message, emotes);
}

// Falls back to a coloured text pill when the badge image isn't in the cache,
// which happens for channel-specific badges we haven't fetched yet.
const BADGE_PILL_MAP = { moderator: 'mod', subscriber: 'sub', vip: 'vip', broadcaster: 'broadcaster', founder: 'founder' };

// `extra` is any badge not from Twitch (currently 7TV), already shaped as
// { url, title }. It renders after the Twitch ones, which is where viewers of
// both the 7TV extension and Chatterino expect it.
function renderBadges(badges, badgeCache, extra) {
  const parts = (badges || []).map(b => {
    const setId = typeof b === 'string' ? b : b.set_id;
    const key = typeof b === 'string' ? b : `${b.set_id}/${b.id}`;
    const hit = badgeCache && badgeCache[key];
    // Cache entries used to be a bare url string; accept both so a stale cached
    // response cannot blank every badge.
    const url = typeof hit === 'string' ? hit : hit?.url;
    const title = (typeof hit === 'string' ? null : hit?.title) || setId;
    if (url) return badgeImg(url, title);
    const cls = BADGE_PILL_MAP[setId];
    return cls
      ? `<span class="chat-badge ${cls}" data-tip="${esc(title)}">${cls === 'broadcaster' ? 'streamer' : cls}</span>`
      : '';
  }).filter(Boolean);

  if (extra?.url) parts.push(badgeImg(extra.url, extra.title || '7TV badge', 'chat-badge-7tv'));
  return parts.length ? `<span class="chat-badges">${parts.join('')}</span>` : '';
}

// data-tip drives the dashboard's own delegated tooltip; title is the fallback
// for the overlay pages, which have no tooltip layer of their own.
function badgeImg(url, title, extraClass) {
  const cls = extraClass ? `chat-badge-img ${extraClass}` : 'chat-badge-img';
  return `<img class="${cls}" src="${esc(url)}" alt="${esc(title)}" ` +
         `title="${esc(title)}" data-tip="${esc(title)}">`;
}

// Node can require this for tests; browsers just get the globals above.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc, nameToColour, renderWords, renderFragment, renderBody, renderBadges, badgeImg, FALLBACK_COLOURS };
}
