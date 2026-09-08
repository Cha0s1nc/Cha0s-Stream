'use strict';

// SCRIPT_ALLOWLIST gates the two places this app will execute something it did
// not ship with: !run (fetch a URL and exec it) and an event trigger's script.
// Both are remote code execution by design, so the matching lives here where it
// can be tested rather than being written twice slightly differently.
//
// The rule: an empty allowlist allows nothing. !run used to skip the check
// entirely when the setting was blank, which turned "enable !run" into "execute
// whatever URL gets pasted".

const path = require('path');

/** Trimmed, lowercased, non-empty entries. */
function parseAllowlist(raw) {
  return (raw || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Host match for !run. An entry covers the domain and its subdomains, so
 * "example.com" allows example.com and cdn.example.com but not notexample.com.
 */
function hostAllowed(scriptUrl, allowlist) {
  if (!allowlist.length) return false;
  let host;
  try {
    host = new URL(scriptUrl).hostname.toLowerCase();
  } catch {
    return false;   // unparseable is not allowed, and must not throw at the caller
  }
  if (!host) return false;
  return allowlist.some(d => host === d || host.endsWith(`.${d}`));
}

/**
 * Directory match for event trigger scripts. A bare startsWith would let
 * /opt/scripts allow /opt/scripts-evil/x.sh, so the separator is required.
 */
function pathAllowed(scriptPath, allowlist) {
  if (!allowlist.length) return false;
  const target = path.resolve(scriptPath);
  return allowlist.some(entry => {
    const root = path.resolve(entry);
    return target === root || target.startsWith(root + path.sep);
  });
}

module.exports = { parseAllowlist, hostAllowed, pathAllowed };
