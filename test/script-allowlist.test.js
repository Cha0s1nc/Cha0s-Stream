'use strict';

// Run: npm test
//
// This gates remote code execution, so the empty case is the important one.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseAllowlist, hostAllowed, pathAllowed } = require('../script-allowlist');

test('an empty or unset allowlist allows nothing', () => {
  for (const raw of [undefined, '', '   ', ',,', ' , , ']) {
    const list = parseAllowlist(raw);
    assert.equal(list.length, 0);
    assert.equal(hostAllowed('https://example.com/x.sh', list), false);
    assert.equal(pathAllowed('/opt/scripts/x.sh', list), false);
  }
});

test('a host entry covers its subdomains and nothing that merely ends with it', () => {
  const list = parseAllowlist('example.com, pub-abc.r2.dev');
  assert.ok(hostAllowed('https://example.com/x.sh', list));
  assert.ok(hostAllowed('https://cdn.example.com/x.sh', list));
  assert.ok(hostAllowed('https://pub-abc.r2.dev/x.sh', list));
  assert.equal(hostAllowed('https://notexample.com/x.sh', list), false);
  assert.equal(hostAllowed('https://example.com.evil.tld/x.sh', list), false);
});

test('host matching ignores case and does not care about the port or path', () => {
  const list = parseAllowlist('Example.COM');
  assert.ok(hostAllowed('https://EXAMPLE.com:8443/deep/path.sh?q=1', list));
});

test('an unparseable url is refused rather than thrown at the caller', () => {
  const list = parseAllowlist('example.com');
  assert.doesNotThrow(() => hostAllowed('http://[', list));
  assert.equal(hostAllowed('http://[', list), false);
  assert.equal(hostAllowed('', list), false);
});

test('a directory entry cannot be escaped by prefix', () => {
  const root = path.resolve('/opt/scripts');
  const list = [root];
  assert.ok(pathAllowed(path.join(root, 'alert.sh'), list));
  assert.ok(pathAllowed(path.join(root, 'nested', 'alert.sh'), list));
  assert.ok(pathAllowed(root, list));
  // The bug this replaced: startsWith alone matched the sibling directory.
  assert.equal(pathAllowed(root + '-evil/alert.sh', list), false);
});

test('a directory entry cannot be escaped by traversal', () => {
  const list = [path.resolve('/opt/scripts')];
  assert.equal(pathAllowed('/opt/scripts/../secrets/x.sh', list), false);
});
