'use strict';

// Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compileRule, compileRules, matchRule, applyRules, presetRules, KNOWN_BOTS,
} = require('../public/chat-filter.js');

const msg = (over = {}) => ({ message: 'hello world', login: 'someone', channel: 'forsen', ...over });

test('a plain pattern is a case-insensitive substring match', () => {
  const r = compileRule({ type: 'hide', field: 'message', pattern: 'WORLD' });
  assert.ok(matchRule(r, msg()));
  assert.ok(!matchRule(r, msg({ message: 'nothing here' })));
});

test('slash-delimited patterns compile to a regex', () => {
  const r = compileRule({ type: 'hide', field: 'message', pattern: '/^hel+o/i' });
  assert.ok(matchRule(r, msg({ message: 'Hellllo there' })));
  assert.ok(!matchRule(r, msg({ message: 'say hello' })));
});

test('an invalid regex disables that rule and reports why, instead of throwing', () => {
  const r = compileRule({ type: 'hide', field: 'message', pattern: '/([unclosed/' });
  assert.equal(r.enabled, false);
  assert.ok(r.error);
  // The whole point: evaluating it must not throw once per message.
  assert.doesNotThrow(() => matchRule(r, msg()));
  assert.equal(matchRule(r, msg()), false);
});

test('an empty pattern is disabled rather than matching everything', () => {
  const r = compileRule({ type: 'hide', field: 'message', pattern: '' });
  assert.equal(r.enabled, false);
  assert.equal(matchRule(r, msg()), false);
});

test('the g flag is stripped so .test() does not alternate', () => {
  const r = compileRule({ type: 'hide', field: 'message', pattern: '/o/g' });
  assert.ok(matchRule(r, msg()));
  assert.ok(matchRule(r, msg()), 'same message must still match on a second call');
});

test('fields select what gets matched', () => {
  const byUser = compileRule({ type: 'hide', field: 'user', pattern: 'someone' });
  const byChan = compileRule({ type: 'hide', field: 'channel', pattern: 'forsen' });
  assert.ok(matchRule(byUser, msg()));
  assert.ok(matchRule(byChan, msg()));
  assert.ok(!matchRule(byUser, msg({ login: 'other' })));
});

test('hide beats highlight on the same message', () => {
  const rules = compileRules([
    { type: 'highlight', field: 'message', pattern: 'hello' },
    { type: 'hide', field: 'user', pattern: 'someone' },
  ]);
  assert.deepEqual(applyRules(rules, msg()), { hide: true, highlight: false });
});

test('a message matching nothing is neither hidden nor highlighted', () => {
  const rules = compileRules([{ type: 'hide', field: 'message', pattern: 'zzz' }]);
  assert.deepEqual(applyRules(rules, msg()), { hide: false, highlight: false });
  assert.deepEqual(applyRules([], msg()), { hide: false, highlight: false });
});

test('a disabled rule is skipped', () => {
  const rules = compileRules([{ type: 'hide', field: 'message', pattern: 'hello', enabled: false }]);
  assert.equal(applyRules(rules, msg()).hide, false);
});

test('presets are ordinary rules and go through the same evaluator', () => {
  const rules = compileRules(presetRules({ hideBots: true, hideCommands: true, highlightMe: true }, 'cha0s_1nc'));
  assert.equal(rules.length, 3);
  assert.ok(applyRules(rules, msg({ login: KNOWN_BOTS[0] })).hide, 'a known bot is hidden');
  assert.ok(applyRules(rules, msg({ message: '!sr something' })).hide, 'a command is hidden');
  assert.ok(applyRules(rules, msg({ message: 'hey @cha0s_1nc look' })).highlight, 'a mention is highlighted');
  assert.equal(applyRules(rules, msg()).hide, false, 'an ordinary message is untouched');
});

test('a login with regex characters cannot break the highlight rule', () => {
  const rules = compileRules(presetRules({ highlightMe: true }, 'a.b+c'));
  assert.equal(rules[0].error, null);
  assert.ok(applyRules(rules, msg({ message: 'hi a.b+c' })).highlight);
  assert.equal(applyRules(rules, msg({ message: 'hi axbxc' })).highlight, false);
});

test('presets asked for nothing produce no rules', () => {
  assert.deepEqual(presetRules({}, 'me'), []);
  assert.deepEqual(presetRules({ highlightMe: true }, ''), [], 'no login means no mention rule');
});
