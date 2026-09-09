'use strict';

// Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { esc, nameToColour, renderWords, renderFragment, renderBody, renderBadges, badgeImg } =
  require('../public/chat-render.js');

const EMOTES = { forsenCD: 'https://cdn.7tv.app/forsenCD.webp' };

test('escapes every character that can break out of text or an attribute', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('a hostile username renders inert', () => {
  const html = renderBody({ message: '<img src=x onerror=alert(1)>' }, {});
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

test('emotes substitute on whole words only', () => {
  assert.ok(renderWords('forsenCD', EMOTES).includes('<img'));
  // Substring matching would rewrite the middle of urls and other words.
  assert.equal(renderWords('xforsenCDx', EMOTES), 'xforsenCDx');
  // Neighbouring plain words survive, and exactly one emote is substituted.
  const mixed = renderWords('a forsenCD b', EMOTES);
  assert.equal(mixed.match(/<img/g).length, 1);
  assert.ok(mixed.startsWith('a ') && mixed.endsWith(' b'));
});

test('native twitch emotes win over the text scan', () => {
  const html = renderFragment({ type: 'emote', emoteId: '25', text: 'Kappa' }, EMOTES);
  assert.ok(html.includes('emoticons/v2/25/'));
});

test('fragments are preferred, raw message is the fallback', () => {
  const withFrags = renderBody({ message: 'ignored', fragments: [{ type: 'text', text: 'hello' }] }, {});
  assert.equal(withFrags, 'hello');
  assert.equal(renderBody({ message: 'hello' }, {}), 'hello');
});

test('badges fall back to a pill, and unknown sets render nothing', () => {
  assert.ok(renderBadges([{ set_id: 'moderator', id: '1' }], {}).includes('chat-badge mod'));
  // An unknown set_id must not produce "undefined" in the output.
  const unknown = renderBadges([{ set_id: 'some_new_badge', id: '1' }], {});
  assert.equal(unknown, '');
  assert.equal(renderBadges([], {}), '');
  assert.equal(renderBadges(null, {}), '');
});

test('a cached badge image beats the pill', () => {
  const html = renderBadges([{ set_id: 'subscriber', id: '12' }], { 'subscriber/12': 'https://x/y.png' });
  assert.ok(html.includes('chat-badge-img'));
  assert.ok(!html.includes('chat-badge sub'));
});

test('name colour is deterministic and always a real colour', () => {
  assert.equal(nameToColour('cha0s_1nc'), nameToColour('cha0s_1nc'));
  assert.match(nameToColour(''), /^#[0-9a-f]{6}$/);
});

test('badges carry their title as a hover tip, not just the set id', () => {
  const html = renderBadges([{ set_id: 'subscriber', id: '12' }],
    { 'subscriber/12': { url: 'https://x/y.png', title: '1-Year Subscriber' } });
  assert.ok(html.includes('data-tip="1-Year Subscriber"'));
  assert.ok(html.includes('title="1-Year Subscriber"'));
});

test('an older cache holding bare url strings still renders', () => {
  const html = renderBadges([{ set_id: 'moderator', id: '1' }], { 'moderator/1': 'https://x/m.png' });
  assert.ok(html.includes('src="https://x/m.png"'));
  assert.ok(html.includes('data-tip="moderator"'));
});

test('a 7TV badge renders last and is marked, whichever path builds it', () => {
  const extra = { url: 'https://cdn.7tv.app/badge/a/1x.webp', title: 'Dino' };
  const html = renderBadges([{ set_id: 'moderator', id: '1' }], { 'moderator/1': { url: 'https://x/m.png', title: 'Moderator' } }, extra);
  assert.ok(html.indexOf('cdn.7tv.app') > html.indexOf('x/m.png'), '7TV badge comes after Twitch ones');
  assert.ok(html.includes('chat-badge-7tv'));
  // The back-fill path must produce the same markup as the inline path.
  assert.ok(badgeImg(extra.url, extra.title, 'chat-badge-7tv').includes('chat-badge-img chat-badge-7tv'));
});

test('a pill fallback also gets a hover tip', () => {
  assert.ok(renderBadges([{ set_id: 'vip', id: '1' }], {}).includes('data-tip="vip"'));
});
