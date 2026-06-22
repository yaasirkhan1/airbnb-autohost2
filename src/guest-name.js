'use strict';
// Safe guest greeting-name resolution.
//
// BUG THIS GUARDS AGAINST: Hospitable's per-message `sender.full_name` can carry the HOST/account
// name (notably on INQUIRIES), so greeting off it blindly once addressed guest "Jamie" as the
// host "Yaasir". The real guest identity is the booking/inquiry GUEST object, not the message
// sender. So resolution is, in priority order:
//   1) the actual guest object (reservation/inquiry guest.first_name) — reliable.
//   2) the message sender name, ONLY if it is NOT a known host/account name.
//   3) null  → the caller greets neutrally ("Hi there"), NEVER by the host's name.
//
// Pure / no side effects (network fetch of the guest object lives in server.js). Returning null
// is safe everywhere: every guest-facing reply builder coalesces `name || 'there'`.

const HOST_ROLES = new Set(['host', 'co-host', 'teammate']);

// First whitespace-delimited token ("Jamie Smith" -> "Jamie"); '' for blank/missing.
function firstToken(s) {
  return String(s == null ? '' : s).trim().split(/\s+/)[0] || '';
}

// Lowercased first-name set of every host/account identity we can see for this thread: the
// configured HOST_NAME plus the sender name on any host-role message (those ARE the host's
// names, straight from Hospitable). Used to reject a sender name that's really the host.
function hostNameSet({ hostEnvName, messages } = {}) {
  const set = new Set();
  const add = (n) => { const t = firstToken(n).toLowerCase(); if (t) set.add(t); };
  add(hostEnvName);
  for (const m of messages || []) {
    if (HOST_ROLES.has(m.sender_role || m.sender_type)) {
      add(m.sender && m.sender.full_name);
      add(m.sender && m.sender.first_name);
    }
  }
  return set;
}

// guest:      the resource's guest object ({ first_name | name }) if fetched, else null.
// senderName: msg.sender.full_name || msg.sender.first_name (may be the host's name).
// hostNames:  Set of lowercased host first-names (from hostNameSet).
// Returns the first name to greet with, or null for a neutral no-name greeting.
function resolveGuestName({ guest, senderName, hostNames } = {}) {
  // 1) The real guest object always wins.
  const fromGuest = firstToken(guest && (guest.first_name || guest.name));
  if (fromGuest) return fromGuest;

  // 2) Fall back to the message sender ONLY if it isn't a known host/account name.
  const cand = firstToken(senderName);
  const hosts = hostNames instanceof Set ? hostNames : new Set();
  if (cand && !hosts.has(cand.toLowerCase())) return cand;

  // 3) Nothing trustworthy → neutral greeting, never the host's name.
  return null;
}

module.exports = { HOST_ROLES, firstToken, hostNameSet, resolveGuestName };
