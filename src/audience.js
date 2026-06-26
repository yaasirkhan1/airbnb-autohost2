'use strict';
// Pure audience parsing + per-guest personalization for the Telegram "broadcast a drafted message"
// flow. parseAudience turns a natural-language phrase into a selector; the server resolves that to
// actual reservations/threads. personalize fills each recipient's first name into the one core message.

const UNITS = ['4-L', '7-B', '18-A', '21-D', '21-I', '23-N', '24-L'];
const keyOf = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^APT/, '');
function canonUnit(token) { const w = keyOf(token); return w ? (UNITS.find(u => keyOf(u) === w) || null) : null; }

// Pull any known unit labels out of free text ("guests in 4-L and 18-A" → ['4-L','18-A']).
function extractUnits(text) {
  const found = [];
  for (const m of String(text || '').matchAll(/\b(?:apt\s*)?(\d{1,2}\s*-?\s*[A-Za-z])\b/g)) {
    const u = canonUnit(m[1]); if (u && !found.includes(u)) found.push(u);
  }
  return found;
}

// Natural language → audience selector. Returns null when it can't tell (caller asks to clarify).
//   { kind: 'arrivals_today'|'checkouts_today'|'checkouts_tomorrow'|'current_guests'|'units', units?: [] }
function parseAudience(text) {
  const t = String(text || '').toLowerCase();
  // NAMED UNITS WIN. If the host names specific units, the audience is exactly those units — even when
  // a time phrase is also present ("today's arrivals in 4-L, 18-A, 21-I" → only those 3). Explicit
  // unit naming is the narrowest, most intentional selector, so it takes precedence over the keywords.
  const units = extractUnits(t);
  if (units.length) return { kind: 'units', units };
  if (/\b(arriving today|today'?s? arrivals|check[-\s]?ins? today|guests? (arriving|checking in) today)\b/.test(t)) return { kind: 'arrivals_today' };
  if (/\b(checking out tomorrow|checkouts? tomorrow|tomorrow'?s? checkouts?|departing tomorrow|departures? tomorrow|leaving tomorrow)\b/.test(t)) return { kind: 'checkouts_tomorrow' };
  if (/\b(checking out today|checkouts? today|today'?s? checkouts?|departing today|departures? today|leaving today)\b/.test(t)) return { kind: 'checkouts_today' };
  if (/\b(current guests|guests staying|in[-\s]?house|everyone (currently )?staying|all (current )?guests|guests (right )?now|current reservations)\b/.test(t)) return { kind: 'current_guests' };
  return null;
}

// Human-readable audience label for the host preview.
function describeAudience(selector, count) {
  const n = `${count} guest${count === 1 ? '' : 's'}`;
  switch (selector && selector.kind) {
    case 'arrivals_today': return `today's arrivals — ${n}`;
    case 'checkouts_today': return `guests checking out today — ${n}`;
    case 'checkouts_tomorrow': return `guests checking out tomorrow — ${n}`;
    case 'current_guests': return `current in-house guests — ${n}`;
    case 'units': return `guests in ${selector.units.join(', ')} — ${n}`;
    default: return n;
  }
}

// Fill one recipient's first name into the core message. The composer is told to include a
// {first_name} token; we also accept a few common variants. If none is present, greet at the top.
function personalize(message, firstName) {
  const name = String(firstName || '').trim().split(/\s+/)[0] || 'there';
  const filled = String(message || '').replace(/\{\{?\s*(first_name|name|guest)\s*\}?\}|\[\s*(first_name|name|guest)\s*\]/gi, name);
  if (filled === String(message || '') && !new RegExp(`\\b${name}\\b`).test(filled)) {
    return `Hi ${name}! ${filled}`.trim();
  }
  return filled;
}

// ── Amending a pending draft's RECIPIENTS (and/or its wording) from a reply ──────
// Classify a reply to a pending broadcast: which units/guests to REMOVE, which units to ADD, and any
// leftover message-wording instruction. A reply can do both ("drop 24-L and make it shorter").
const ADD_MARK = /\b(also\s+add|^\s*add|adding|include|including|plus)\b/i;
const REMOVE_MARK = /\b(no|not|remove|removing|drop|dropping|exclude|excluding|without|take\s+off|minus|leave\s+out|skip|don'?t\s+(send|include|message))\b/i;
const FILLER = /^(the\s+rest\s+(are|is)\s+fine|that'?s\s+(it|all|fine)|rest\s+(are\s+)?fine|keep\s+the\s+rest|leave\s+the\s+rest|the\s+rest|ok(ay)?|fine|good|perfect|great|thanks?|yes\s+the\s+rest)\.?$/i;
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const splitClauses = text => String(text || '').split(/\s*(?:,|;|\band\b|\bbut\b)\s*/i).map(s => s.trim()).filter(Boolean);

function namesInClause(clause, members) {
  const c = String(clause || '').toLowerCase(), out = [];
  for (const m of members || []) {
    const fn = String(m.firstName || '').toLowerCase(), gn = String(m.guestName || '').toLowerCase();
    if (fn && new RegExp(`\\b${escapeRe(fn)}\\b`).test(c)) out.push(m.firstName);
    else if (gn && gn.length > 2 && c.includes(gn)) out.push(m.firstName);
  }
  return out;
}

function parseRecipientEdit(text, members = []) {
  const removeUnits = [], addUnits = [], removeNames = [], residual = [];
  let mode = null; // 'remove' | 'add' — carried across bare clauses so "no 21-D and 24-L" removes BOTH
  for (const clause of splitClauses(text)) {
    const units = extractUnits(clause);
    const names = namesInClause(clause, members);
    if (REMOVE_MARK.test(clause)) mode = 'remove';
    else if (ADD_MARK.test(clause)) mode = 'add';
    if (units.length || names.length) {
      if (mode === 'add') { for (const u of units) if (!addUnits.includes(u)) addUnits.push(u); }
      else if (mode === 'remove') {
        for (const u of units) if (!removeUnits.includes(u)) removeUnits.push(u);
        for (const n of names) if (!removeNames.includes(n)) removeNames.push(n);
      } // mode null + bare unit/name → ambiguous, ignored (no silent recipient change)
      continue;
    }
    mode = null;  // a clause with no unit/name ends the directive run
    if (clause && !FILLER.test(clause)) residual.push(clause);   // → wording edit
  }
  return {
    removeUnits, removeNames, addUnits,
    textEdit: residual.length ? residual.join(', ') : null,
    hasRecipientChange: !!(removeUnits.length || removeNames.length || addUnits.length),
  };
}

// Filter members by removal directives (by unit label and/or guest name).
function applyRecipientRemovals(members, { removeUnits = [], removeNames = [] } = {}) {
  const ru = new Set(removeUnits.map(u => String(u).toUpperCase()));
  const rn = new Set(removeNames.map(n => String(n).toLowerCase()));
  return (members || []).filter(m =>
    !ru.has(String(m.unit || '').toUpperCase()) &&
    !rn.has(String(m.firstName || '').toLowerCase()) &&
    !rn.has(String(m.guestName || '').toLowerCase()));
}

// Render the one core message per recipient → [{ reservationId, firstName, body }]. The body for a
// member is ALWAYS keyed to that member's own reservationId + name — the per-thread send guard.
function renderBroadcast(members, message) {
  return (members || [])
    .filter(m => m && m.reservationId)
    .map(m => ({ reservationId: m.reservationId, firstName: m.firstName, body: personalize(message, m.firstName) }));
}

module.exports = { UNITS, canonUnit, extractUnits, parseAudience, describeAudience, personalize, renderBroadcast, parseRecipientEdit, applyRecipientRemovals };
