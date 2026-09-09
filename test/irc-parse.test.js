'use strict';

// Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIrcTags, parseBadges, parseEmotePositions, buildFragments, parseIrcMessage } =
  require('../irc-parse');

// A real line captured from recent-messages.robotty.de.
const REAL = '@display-name=crane__0;id=ea336480-b48e-4d52-a429-fe5017c23129;color=#E8FF18;' +
  'badge-info=subscriber/23;subscriber=1;room-id=22484632;mod=0;user-id=683242212;historical=1;' +
  'badges=subscriber/12,charmander/1;emotes=emotesv2_fcd327f5faf84309b7ba574a6716026d:0-13;' +
  'tmi-sent-ts=1788938117007 :crane__0!crane__0@crane__0.tmi.twitch.tv PRIVMSG #forsen :databaseHappie';

test('a real historical line parses into the live payload shape', () => {
  const m = parseIrcMessage(REAL);
  assert.equal(m.user, 'crane__0');
  assert.equal(m.login, 'crane__0');
  assert.equal(m.channel, 'forsen');
  assert.equal(m.channelId, '22484632');
  assert.equal(m.userId, '683242212');
  assert.equal(m.color, '#E8FF18');
  assert.equal(m.id, 'ea336480-b48e-4d52-a429-fe5017c23129');
  assert.equal(m.ts, 1788938117007);
  assert.equal(m.historical, true);
  assert.deepEqual(m.badges, [{ set_id: 'subscriber', id: '12' }, { set_id: 'charmander', id: '1' }]);
  assert.deepEqual(m.fragments, [
    { type: 'emote', text: 'databaseHappie', emoteId: 'emotesv2_fcd327f5faf84309b7ba574a6716026d' },
  ]);
});

test('non-PRIVMSG lines are rejected rather than half-parsed', () => {
  assert.equal(parseIrcMessage('@x=1 :tmi.twitch.tv ROOMSTATE #forsen'), null);
  assert.equal(parseIrcMessage(':tmi.twitch.tv PING'), null);
  assert.equal(parseIrcMessage('PING :tmi.twitch.tv'), null);
  assert.equal(parseIrcMessage(''), null);
  assert.equal(parseIrcMessage(null), null);
  assert.equal(parseIrcMessage('@only-tags-no-body'), null);
});

test('tag values are unescaped per IRCv3', () => {
  const t = parseIrcTags('a=hello\\sworld;b=semi\\:colon;c=back\\\\slash;d=;e');
  assert.equal(t.a, 'hello world');
  assert.equal(t.b, 'semi;colon');
  assert.equal(t.c, 'back\\slash');
  assert.equal(t.d, '');
  assert.equal(t.e, '');
});

test('a trailing backslash does not run off the end of the value', () => {
  assert.equal(parseIrcTags('a=oops\\').a, 'oops');
});

test('badge names containing a slash keep their version', () => {
  assert.deepEqual(parseBadges('subscriber/2012'), [{ set_id: 'subscriber', id: '2012' }]);
  assert.deepEqual(parseBadges(''), []);
  // Split on the LAST slash, so a set id with one in it survives.
  assert.deepEqual(parseBadges('some/set/3'), [{ set_id: 'some/set', id: '3' }]);
});

test('emote ranges are collected and ordered by position', () => {
  assert.deepEqual(parseEmotePositions('a:5-9/b:0-3,11-14'), [
    { id: 'b', start: 0, end: 3 },
    { id: 'a', start: 5, end: 9 },
    { id: 'b', start: 11, end: 14 },
  ]);
  assert.deepEqual(parseEmotePositions(''), []);
  assert.deepEqual(parseEmotePositions('garbage'), []);
});

test('text around emotes is preserved in order', () => {
  assert.deepEqual(buildFragments('hey Kappa there', 'k:4-8'), [
    { type: 'text', text: 'hey ', emoteId: null },
    { type: 'emote', text: 'Kappa', emoteId: 'k' },
    { type: 'text', text: ' there', emoteId: null },
  ]);
});

test('a message with no emotes is one text fragment', () => {
  assert.deepEqual(buildFragments('plain words', ''), [{ type: 'text', text: 'plain words', emoteId: null }]);
});

test('emote positions count code points, not UTF-16 units', () => {
  // The emoji is one code point but two UTF-16 units; indexing by .slice would
  // put the emote one character off.
  const frags = buildFragments('\u{1F600} Kappa', 'k:2-6');
  assert.deepEqual(frags, [
    { type: 'text', text: '\u{1F600} ', emoteId: null },
    { type: 'emote', text: 'Kappa', emoteId: 'k' },
  ]);
});

test('out-of-range or overlapping emote ranges are skipped, not crashed on', () => {
  assert.deepEqual(buildFragments('short', 'k:0-99'), [{ type: 'text', text: 'short', emoteId: null }]);
  // Second range starts inside the first: keep the first, drop the overlap.
  const frags = buildFragments('abcdef', 'k:0-2/j:1-3');
  assert.equal(frags[0].type, 'emote');
  assert.equal(frags.map(f => f.text).join(''), 'abcdef');
});

test('a message containing a colon still parses', () => {
  const m = parseIrcMessage('@id=1 :a!a@a.tmi.twitch.tv PRIVMSG #chan :look: http://x/y :)');
  assert.equal(m.message, 'look: http://x/y :)');
});
