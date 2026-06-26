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
  if (/\b(arriving today|today'?s? arrivals|check[-\s]?ins? today|guests? (arriving|checking in) today)\b/.test(t)) return { kind: 'arrivals_today' };
  if (/\b(checking out tomorrow|checkouts? tomorrow|tomorrow'?s? checkouts?|departing tomorrow|departures? tomorrow|leaving tomorrow)\b/.test(t)) return { kind: 'checkouts_tomorrow' };
  if (/\b(checking out today|checkouts? today|today'?s? checkouts?|departing today|departures? today|leaving today)\b/.test(t)) return { kind: 'checkouts_today' };
  if (/\b(current guests|guests staying|in[-\s]?house|everyone (currently )?staying|all (current )?guests|guests (right )?now|current reservations)\b/.test(t)) return { kind: 'current_guests' };
  const units = extractUnits(t);
  if (units.length) return { kind: 'units', units };
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

// Render the one core message per recipient → [{ reservationId, firstName, body }]. The body for a
// member is ALWAYS keyed to that member's own reservationId + name — the per-thread send guard.
function renderBroadcast(members, message) {
  return (members || [])
    .filter(m => m && m.reservationId)
    .map(m => ({ reservationId: m.reservationId, firstName: m.firstName, body: personalize(message, m.firstName) }));
}

module.exports = { UNITS, canonUnit, extractUnits, parseAudience, describeAudience, personalize, renderBroadcast };
