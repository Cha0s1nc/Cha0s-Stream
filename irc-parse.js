'use strict';

// Parses raw IRCv3 lines into the same shape handleChatMessage broadcasts, so
// backfilled history renders through exactly the same path as live messages.
//
// Only used for scrollback from recent-messages.robotty.de. Live chat comes from
// EventSub, which hands us this structure already built.

// IRCv3 tag values escape these five sequences.
function unescapeTagValue(v) {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== '\\') { out += v[i]; continue; }
    const next = v[++i];
    if (next === ':') out += ';';
    else if (next === 's') out += ' ';
    else if (next === 'r') out += '\r';
    else if (next === 'n') out += '\n';
    else if (next === undefined) break;   // trailing backslash: drop it
    else out += next;                     // includes \\ -> \
  }
  return out;
}

function parseIrcTags(raw) {
  const tags = {};
  for (const pair of String(raw || '').split(';')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) tags[pair] = '';
    else tags[pair.slice(0, eq)] = unescapeTagValue(pair.slice(eq + 1));
  }
  return tags;
}

// "subscriber/12,moderator/1" -> [{set_id:'subscriber', id:'12'}, ...]
function parseBadges(raw) {
  if (!raw) return [];
  return String(raw).split(',').filter(Boolean).map(part => {
    const slash = part.lastIndexOf('/');
    return slash === -1
      ? { set_id: part, id: '1' }
      : { set_id: part.slice(0, slash), id: part.slice(slash + 1) };
  });
}

// "id1:0-4,6-10/id2:12-15" -> [{id, start, end}, ...] sorted by position.
// Twitch counts positions in code points, not UTF-16 units, which is why the
// caller splits the text with Array.from rather than by index.
function parseEmotePositions(raw) {
  const out = [];
  if (!raw) return out;
  for (const chunk of String(raw).split('/')) {
    const colon = chunk.indexOf(':');
    if (colon === -1) continue;
    const id = chunk.slice(0, colon);
    for (const range of chunk.slice(colon + 1).split(',')) {
      const [s, e] = range.split('-').map(Number);
      if (Number.isInteger(s) && Number.isInteger(e)) out.push({ id, start: s, end: e });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Splits the text into the {type, text, emoteId} fragments the renderer expects.
function buildFragments(text, emotesTag) {
  const positions = parseEmotePositions(emotesTag);
  if (!positions.length) return [{ type: 'text', text, emoteId: null }];

  const chars = Array.from(text);          // code points, per Twitch's indexing
  const frags = [];
  let cursor = 0;
  for (const { id, start, end } of positions) {
    if (start < cursor || end >= chars.length) continue;   // overlapping or stale range
    if (start > cursor) frags.push({ type: 'text', text: chars.slice(cursor, start).join(''), emoteId: null });
    frags.push({ type: 'emote', text: chars.slice(start, end + 1).join(''), emoteId: id });
    cursor = end + 1;
  }
  if (cursor < chars.length) frags.push({ type: 'text', text: chars.slice(cursor).join(''), emoteId: null });
  return frags;
}

/**
 * One raw IRC line -> a chat payload, or null if it is not a chat message.
 *
 * Anything that is not a PRIVMSG (JOIN, CLEARCHAT, USERNOTICE, PING) returns
 * null rather than a half-filled object, so the caller can filter on falsy.
 */
function parseIrcMessage(line) {
  const raw = String(line || '');
  if (!raw.startsWith('@')) return null;

  const sp = raw.indexOf(' ');
  if (sp === -1) return null;
  const tags = parseIrcTags(raw.slice(1, sp));
  const rest = raw.slice(sp + 1);

  // :nick!user@host PRIVMSG #channel :text
  const m = rest.match(/^:([^!]+)![^ ]+ PRIVMSG #([^ ]+) :([\s\S]*)$/);
  if (!m) return null;
  const [, login, channel, text] = m;

  const ts = Number(tags['tmi-sent-ts']);
  return {
    event: 'chat',
    user: tags['display-name'] || login,
    login,
    color: tags.color || '',
    badges: parseBadges(tags.badges),
    message: text,
    fragments: buildFragments(text, tags.emotes),
    channel,
    channelId: tags['room-id'] || '',
    id: tags.id || '',
    userId: tags['user-id'] || '',
    sourceChannel: null,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    historical: true,
  };
}

module.exports = { parseIrcTags, parseBadges, parseEmotePositions, buildFragments, parseIrcMessage };
