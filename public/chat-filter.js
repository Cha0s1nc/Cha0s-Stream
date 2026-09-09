'use strict';

// Chat filtering. Dual-use on purpose: the browser loads it with <script src>,
// node:test requires it, and listener.js requires it for the bot list so that
// list exists in exactly one place.
//
// A rule is { type, field, pattern, enabled }:
//   type    'hide' | 'highlight'
//   field   'message' | 'user' | 'channel'
//   pattern either /regex/flags or a plain case-insensitive substring
//
// ponytail: substring and /regex/ against one field, with no boolean composition.
// Chatterino's filter language is a tokenizer, a parser, a type-coercion matrix
// and a field table — about 2,400 lines of C++ — for expressions like
// `author.subscribed && message.content contains "x"`. compileRules/applyRules is
// the seam that swaps in: replace the body of compileRule and nothing else moves.

// Bots whose output is noise in a chat pane and in text-to-speech alike.
const KNOWN_BOTS = [
  'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot',
  'wizebot', 'botrixoficial', 'sery_bot', 'own3d',
];

const RULE_TYPES = ['hide', 'highlight'];
const RULE_FIELDS = ['message', 'user', 'channel'];

function fieldValue(msg, field) {
  if (field === 'user') return String(msg.login || msg.user || '');
  if (field === 'channel') return String(msg.channel || '');
  return String(msg.message || '');
}

// Compiles once, at rule-save time. Doing it per message would rebuild the same
// RegExp hundreds of times a minute, and a bad pattern would throw just as often;
// here an invalid regex disables that one rule and reports why.
function compileRule(rule) {
  const out = {
    type: RULE_TYPES.includes(rule?.type) ? rule.type : 'hide',
    field: RULE_FIELDS.includes(rule?.field) ? rule.field : 'message',
    pattern: String(rule?.pattern ?? ''),
    enabled: rule?.enabled !== false,
    re: null,
    error: null,
  };
  if (!out.pattern) {
    out.error = 'Empty pattern';
    out.enabled = false;
    return out;
  }
  const m = out.pattern.match(/^\/(.*)\/([gimsuy]*)$/);
  if (m) {
    try {
      // Drop /g: a stateful lastIndex would make .test() alternate between
      // true and false on identical messages.
      out.re = new RegExp(m[1], m[2].replace(/g/g, ''));
    } catch (err) {
      out.error = err.message;
      out.enabled = false;
    }
  }
  return out;
}

function compileRules(rules) {
  return (Array.isArray(rules) ? rules : []).map(compileRule);
}

function matchRule(compiled, msg) {
  if (!compiled.enabled) return false;
  const value = fieldValue(msg, compiled.field);
  if (compiled.re) return compiled.re.test(value);
  return value.toLowerCase().includes(compiled.pattern.toLowerCase());
}

// Hide wins over highlight: a hidden message is not shown, so there is nothing
// left to highlight.
function applyRules(compiled, msg) {
  let hide = false;
  let highlight = false;
  for (const rule of compiled) {
    if (!matchRule(rule, msg)) continue;
    if (rule.type === 'hide') hide = true;
    else highlight = true;
  }
  return { hide: hide, highlight: highlight && !hide };
}

// Presets are ordinary rules, not a parallel code path, so there is one evaluator
// and the checkboxes are editable as rules once someone wants to tweak them.
function presetRules({ hideBots, hideCommands, highlightMe } = {}, myLogin = '') {
  const rules = [];
  if (hideBots) {
    rules.push({ type: 'hide', field: 'user', pattern: `/^(${KNOWN_BOTS.join('|')})$/i`, enabled: true, preset: 'hideBots' });
  }
  if (hideCommands) {
    rules.push({ type: 'hide', field: 'message', pattern: '/^\\s*!/', enabled: true, preset: 'hideCommands' });
  }
  if (highlightMe && myLogin) {
    // Escaped: a login is user data, and Twitch allows underscores that would
    // otherwise be fine but a future format change should not become a regex bug.
    const safe = String(myLogin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rules.push({ type: 'highlight', field: 'message', pattern: `/@?${safe}\\b/i`, enabled: true, preset: 'highlightMe' });
  }
  return rules;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KNOWN_BOTS, RULE_TYPES, RULE_FIELDS,
    compileRule, compileRules, matchRule, applyRules, presetRules,
  };
}
