'use strict';
// Vacant-night extension offers. At 7 PM ET a sweep finds every guest checking out TOMORROW whose
// SAME unit's checkout-night is vacant (no same-day turnover), prices the extra night at the live
// calendar price + a vacancy-scaled markup, and auto-sends a warm offer to that guest's thread.
// When the guest replies with a clear affirmative, the host is pinged on Telegram to do the
// Alter Reservation in Hospitable by hand (the public API cannot extend a booking).
//
// This module is PURE + a small JSON store (no network). The I/O — fetching reservations/calendar,
// sending the message, pinging the host — is wired around it in server.js (cron path) and in
// scripts/extension-offer-dryrun.js (read-only preview). Mirrors the wc-fill.js / wc-fill-run.js split.
const fs = require('fs');
const path = require('path');

// EXACT host-approved template. {guest_name} and {price} are the only variables. NOTE: the literal
// "$" before "{price}" is intentional ("only ${price}" → "only $118"); the file uses single-quoted
// strings so "${price}" is plain text, not a JS interpolation.
const TEMPLATE =
  'Hi {guest_name}! Since you\'ve been such a wonderful guest, we\'d love to offer you an exclusive 20% discount if you\'d like to extend for an additional night.\n\n' +
  'I noticed your apartment is still available tomorrow night before our next guest arrives, so you\'re welcome to simply stay and keep relaxing right where you are. With the discount, your extra night would be only ${price}.\n\n' +
  'If you\'d like to extend, just reply tonight and I\'ll take care of everything. If not, no worries at all — our cleaning team will be by the next morning at 11:00 AM.\n\n' +
  'It\'s been a pleasure hosting you, and I hope you\'ve had a wonderful visit!\n\n' +
  '— Cal';

// ── pricing (pure) ───────────────────────────────────────────────────────────
// Vacancy-scaled markup, whole dollars: fewer units vacant → hold firmer; more vacant → fill harder.
//   1 vacant → +$10, 2 → +$7, 3+ → +$5  (>5 capped at the aggressive +$5 fill tier).
function scaleMarkup(vacantCount) {
  if (vacantCount <= 1) return 10;
  if (vacantCount === 2) return 7;
  return 5;
}
// Guest-facing quote = whole-dollar calendar price + markup.
function computeQuote(calendarPrice, vacantCount) {
  return Math.round(calendarPrice) + scaleMarkup(vacantCount);
}

// ── eligibility (pure) ───────────────────────────────────────────────────────
// A unit is eligible when a guest checks out tomorrow (outgoing) AND no one checks in that day
// (incoming empty = NOT a same-day turnover). Calendar availability is checked separately by the
// caller; both must hold. Mirrors getReservationsForDate's { outgoing, incoming } shape.
function isEligible({ outgoing, incoming } = {}) {
  const out = Array.isArray(outgoing) ? outgoing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  return out.length >= 1 && inc.length === 0;
}

// ── wrong-thread guard (pure) ────────────────────────────────────────────────
const defaultNameOf = r => (r && r.guest && (r.guest.full_name || r.guest.first_name)) || (r && r.guest_name) || '';
function firstToken(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }

// Re-confirm at send time: send ONLY when exactly one reservation still checks out on the date AND
// its guest's first name matches the one captured at scan time. Anything else (0 / many / renamed /
// nameless) → refuse, so an offer can never land in the wrong guest's thread.
function matchOfferReservation(outgoing, expectedFirstName, nameOf = defaultNameOf) {
  if (!Array.isArray(outgoing) || outgoing.length !== 1) {
    return { ok: false, reason: `expected exactly 1 checkout, got ${Array.isArray(outgoing) ? outgoing.length : 0}` };
  }
  const r = outgoing[0];
  const fn = firstToken(nameOf(r));
  if (!fn) return { ok: false, reason: 'reservation has no guest name' };
  if (expectedFirstName && fn.toLowerCase() !== String(expectedFirstName).toLowerCase()) {
    return { ok: false, reason: `guest changed (${fn} != ${expectedFirstName})` };
  }
  return { ok: true, reservation: r, firstName: fn };
}

// ── rendering (pure) ─────────────────────────────────────────────────────────
function renderOffer(guestName, price, template = TEMPLATE) {
  return template
    .replace(/\{guest_name\}/g, String(guestName))
    .replace(/\{price\}/g, String(price));
}

// ── reply classification (pure) ──────────────────────────────────────────────
// Only a CLEAR affirmative pings the host. Negatives are recorded (no ping). Questions / anything
// ambiguous → 'other' (leave the offer open, let the normal responder answer). Negative is checked
// first so "no thanks" can't be read as a yes; a '?' (or a leading question word) is never a yes.
const NEGATIVE = /\b(no|nope|nah|not interested|no thanks?|we'?re good|all set|all good|pass|decline|maybe not|unfortunately|can'?t|cannot)\b/i;
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|absolutely|definitely|of course|sounds good|that works|we'?ll take it|we will take it|let'?s do it|sign us up|count us in|please do|yes please|love to|deal|ok|okay)\b/i;
function classifyReply(text) {
  const t = String(text || '').trim();
  if (!t) return 'other';
  if (NEGATIVE.test(t)) return 'negative';
  if (/\?/.test(t) || /^(what|how|when|where|which|can i|could i|do you|is it|are there|how much)\b/i.test(t)) return 'other';
  if (AFFIRMATIVE.test(t)) return 'affirmative';
  return 'other';
}

// Decision for an incoming reply on a thread that has a PENDING offer. Pure so it's unit-testable.
//   { ping: send host a Telegram alert?, status: new offer status, suppress: skip the generic auto-reply? }
function decideOnReply(offer, body) {
  if (!offer || offer.status !== 'pending') return { ping: false, status: offer ? offer.status : null, suppress: false };
  const cls = classifyReply(body);
  if (cls === 'affirmative') return { ping: true, status: 'accepted', suppress: true };
  if (cls === 'negative') return { ping: false, status: 'declined', suppress: false };
  return { ping: false, status: 'pending', suppress: false };
}

// ── offer store (date-keyed by reservation id; auto-expires) ──────────────────
const storePath = () =>
  path.join(process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'extension-offers.json');

function recordOffer(store, reservationId, info) {
  return { ...(store || {}), [reservationId]: { ...info } };
}
function getOffer(store, reservationId) { return (store || {})[reservationId] || null; }
function resolveOffer(store, reservationId, status) {
  const s = { ...(store || {}) };
  if (s[reservationId]) s[reservationId] = { ...s[reservationId], status, resolvedAt: new Date().toISOString() };
  return s;
}
// Drop offers whose offered night is already in the past (todayStr lexical compare, YYYY-MM-DD).
function pruneOffers(store, todayStr) {
  const out = {};
  for (const [id, o] of Object.entries(store || {})) if (!o.date || o.date >= todayStr) out[id] = o;
  return out;
}

function loadStore() { try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return {}; } }
function saveStore(store) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2));
}

module.exports = {
  TEMPLATE,
  scaleMarkup, computeQuote,
  isEligible, matchOfferReservation, firstToken, defaultNameOf,
  renderOffer,
  classifyReply, decideOnReply,
  recordOffer, getOffer, resolveOffer, pruneOffers,
  loadStore, saveStore, storePath,
};
