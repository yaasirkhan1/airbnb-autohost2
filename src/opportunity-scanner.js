'use strict';
// Opportunity scanner (Phase 0 of the daily upsell digest). PURE detection + pricing + digest format
// + the approve/override/skip decision parser. The live data fetch, the morning cron, the Telegram
// send, and (later) the learning layer wrap around this — same pure-core pattern as the rest of the repo.
//
// A unit snapshot (built by the server from Hospitable):
//   { unit, propertyId, today, tomorrow,
//     reservations: [{ id, guest, firstName, checkIn, checkOut, status }],
//     calendar: { 'YYYY-MM-DD': { available: bool, price: number } } }
const { scaleMarkup } = require('./extension-offer');   // pure; reuse the vacancy-scaled markup

const EARLY_CHECKIN_FEE = 45;   // existing policy: early check-in from 1 PM, $45
const LATE_CHECKOUT_FEE = 45;   // existing policy: late checkout to 1:30 PM, $45

const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nightVacant = (u, d) => !!(u.calendar && u.calendar[d] && u.calendar[d].available === true);
// EXPLICITLY booked — available===false. Missing calendar data is "unknown", NOT a booked wall, so a
// gap boundary requires a real booking (prevents fabricating orphan gaps from absent data).
const nightBooked = (u, d) => !!(u.calendar && u.calendar[d] && u.calendar[d].available === false);
const checkoutOn = (u, d) => (u.reservations || []).find(r => r.checkOut === d) || null;
const checkinOn  = (u, d) => (u.reservations || []).find(r => r.checkIn === d) || null;

// ── detectors (each returns an opportunity, or null) ────────────────────────────
// EXTENSION: guest checks out tomorrow, that night is vacant, and it's not a same-day turnover.
function detectExtension(u) {
  const out = checkoutOn(u, u.tomorrow);
  if (!out) return null;
  if (checkinOn(u, u.tomorrow)) return null;                 // someone arrives → not vacant
  if (!nightVacant(u, u.tomorrow)) return null;
  return opp('extension', u, out, { night: u.tomorrow }, { calendarPrice: u.calendar[u.tomorrow].price });
}
// EARLY CHECK-IN: a guest genuinely arrives TOMORROW (same date basis as the rest of the digest) AND
// the unit is VACANT the night before that arrival (calendar for arrival − 1) — so it can truly be
// ready early. The night-before vacancy check also excludes same-day turnovers (a prior guest
// occupying that night leaves it not-vacant), which is what makes early check-in actually feasible.
function detectEarlyCheckin(u) {
  const arr = checkinOn(u, u.tomorrow);
  if (!arr) return null;
  if (!nightVacant(u, addDays(u.tomorrow, -1))) return null;
  return opp('early_checkin', u, arr, { checkin: u.tomorrow }, {});
}
// LATE CHECKOUT: a guest checks out tomorrow and no one arrives tomorrow (unit isn't turning over).
function detectLateCheckout(u) {
  const out = checkoutOn(u, u.tomorrow);
  if (!out) return null;
  if (checkinOn(u, u.tomorrow)) return null;
  return opp('late_checkout', u, out, { checkout: u.tomorrow }, {});
}
// GAP FILL: an isolated vacant night (booked on both sides) in the window. Recipient = the guest
// checking out into the gap if there is one (extend), else it's surfaced as info-only (manual).
function detectGapFill(u, windowDays = 10) {
  const gaps = [];
  // start at i=2 (day after tomorrow): tomorrow is already covered by extension/late-checkout.
  for (let i = 2; i < windowDays; i++) {
    const d = addDays(u.today, i);
    if (nightVacant(u, d) && nightBooked(u, addDays(d, -1)) && nightBooked(u, addDays(d, 1))) {
      const out = checkoutOn(u, d);
      gaps.push(opp('gap_fill', u, out, { night: d }, { calendarPrice: (u.calendar[d] || {}).price }));
    }
  }
  return gaps;
}
function opp(type, u, res, dates, baseline) {
  return {
    type, unit: u.unit, propertyId: u.propertyId,
    reservationId: res ? res.id : null,
    guest: res ? res.guest : null, firstName: res ? (res.firstName || (res.guest || '').split(/\s+/)[0]) : null,
    dates, baseline,
  };
}

// Scan one unit → all its opportunities.
function scanUnit(u) {
  return [detectExtension(u), detectEarlyCheckin(u), detectLateCheckout(u), ...detectGapFill(u)].filter(Boolean);
}

// ── suggestion pricing (pure) ───────────────────────────────────────────────────
// extension → calendar + vacancy-scaled markup; early/late → flat fee; gap_fill → calendar price.
function suggestPrice(o, { vacantCount = 1 } = {}) {
  if (o.type === 'extension') return Math.round((o.baseline.calendarPrice || 0)) + scaleMarkup(vacantCount);
  if (o.type === 'early_checkin') return EARLY_CHECKIN_FEE;
  if (o.type === 'late_checkout') return LATE_CHECKOUT_FEE;
  if (o.type === 'gap_fill') return Math.round(o.baseline.calendarPrice || 0) || null;
  return null;
}

// Build the digest items (priced + indexed + a stable id), given all units' opportunities + vacancy count.
const TYPE_LABEL = { extension: 'EXTENSION', early_checkin: 'EARLY CHECK-IN', late_checkout: 'LATE CHECKOUT', gap_fill: 'GAP FILL' };
function buildDigestItems(opps, ctx) {
  return opps.map((o, i) => ({
    n: i + 1, id: `${o.type}:${o.unit}:${Object.values(o.dates)[0]}`,
    ...o, suggested: suggestPrice(o, ctx), chosen: null, decision: 'pending',
  }));
}

// SAME-GUEST STACKING: items that target the same reservation (one guest has >1 opportunity).
// Returns a map reservationId → [item numbers]. Used to FLAG so the host never accidentally sends a
// single guest two upsells.
function sameGuestStacks(items) {
  const byRes = {};
  for (const it of items) if (it.reservationId) (byRes[it.reservationId] = byRes[it.reservationId] || []).push(it.n);
  return Object.fromEntries(Object.entries(byRes).filter(([, ns]) => ns.length > 1));
}
// Among APPROVED items, same-guest conflicts (sending these would double-message one guest).
function sameGuestConflicts(items) {
  const byRes = {};
  for (const it of items) if (it.decision === 'approve' && it.reservationId) (byRes[it.reservationId] = byRes[it.reservationId] || []).push(it);
  return Object.entries(byRes).filter(([, arr]) => arr.length > 1).map(([rid, arr]) => ({ reservationId: rid, firstName: arr[0].firstName, items: arr.map(x => x.n) }));
}

// ── digest formatting ────────────────────────────────────────────────────────────
function formatDigest(items, dateStr) {
  if (!items.length) return `☀️ Opportunity scan for ${dateStr}: nothing to offer today.`;
  const stacks = sameGuestStacks(items);
  const lines = items.map(it => {
    const who = it.firstName ? `${it.firstName} (${it.unit})` : `${it.unit} — no guest (manual)`;
    const when = Object.values(it.dates)[0];
    const price = it.suggested != null ? `$${it.suggested}` : 'n/a';
    const tag = it.decision === 'approve' ? ` ✅${it.chosen != null && it.chosen !== it.suggested ? ` @ $${it.chosen}` : ''}`
      : it.decision === 'skip' ? ' ⏭️ skipped' : '';
    const others = (stacks[it.reservationId] || []).filter(n => n !== it.n);
    const stackNote = others.length ? `  ⚠️ same guest as #${others.join(', #')} — pick one` : '';
    return `${it.n}. ${TYPE_LABEL[it.type]} · ${who} · ${when} · suggested ${price}${tag}${stackNote}`;
  });
  const stackCount = Object.keys(stacks).length;
  const banner = stackCount ? `\n\n⚠️ ${stackCount} guest(s) have multiple options — don't send the same guest two upsells; skip the extras.` : '';
  return `☀️ Opportunities for ${dateStr} — ${items.length} found\n\n${lines.join('\n')}${banner}\n\n` +
    `Reply: "approve 1 2", "skip 3", "1 at $85" (override), "approve all" — then "send". Nothing goes to guests until you send.`;
}

// ── approve / override / skip parser (pure) ──────────────────────────────────────
// Returns a list of ops: {op:'approve'|'skip'|'override'|'all'|'send'|'cancel', n?, value?}.
function parseDigestDecision(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return [];
  if (/^(cancel|nevermind|never mind|stop)\b/.test(t)) return [{ op: 'cancel' }];
  if (/^(send|send it|go|do it|fire)\b/.test(t)) return [{ op: 'send' }];
  if (/\b(approve all|all|yes all|approve everything)\b/.test(t)) return [{ op: 'all' }];
  const ops = [];
  // overrides: "1 at $85", "1 $85", "item 2 90", "3 to 60"
  for (const m of t.matchAll(/\b(?:item\s*)?(\d+)\s*(?:at|to|=|@|\$)?\s*\$?\s*(\d{2,4})\b/g)) {
    ops.push({ op: 'override', n: +m[1], value: +m[2] });
  }
  const claimed = new Set(ops.map(o => o.n));
  // approvals: "approve 1 2", "yes 1,3", or a bare list "1 2"
  if (/\b(approve|yes|ok|okay|keep|send)\b/.test(t) || /^[\d\s,]+$/.test(t)) {
    for (const m of t.replace(/\b(approve|yes|ok|okay|keep)\b/g, ' ').matchAll(/\b(\d+)\b/g)) {
      const n = +m[1]; if (!claimed.has(n) && !ops.some(o => o.op === 'approve' && o.n === n)) ops.push({ op: 'approve', n });
    }
  }
  // skips/removals: "skip 3", "no 2", "drop 4", "not 1"
  if (/\b(skip|no|drop|not|remove|exclude)\b/.test(t)) {
    const after = t.split(/\b(skip|no|drop|not|remove|exclude)\b/).slice(1).join(' ');
    for (const m of after.matchAll(/\b(\d+)\b/g)) ops.push({ op: 'skip', n: +m[1] });
  }
  return ops;
}

// Apply parsed ops to the items → new items (immutable). Overrides imply approval at the chosen price.
function applyDecisions(items, ops) {
  let next = items.map(it => ({ ...it }));
  for (const o of ops) {
    if (o.op === 'all') next = next.map(it => ({ ...it, decision: it.decision === 'skip' ? 'skip' : 'approve', chosen: it.chosen ?? it.suggested }));
    else if (o.op === 'approve') next = next.map(it => it.n === o.n ? { ...it, decision: 'approve', chosen: it.chosen ?? it.suggested } : it);
    else if (o.op === 'skip') next = next.map(it => it.n === o.n ? { ...it, decision: 'skip' } : it);
    else if (o.op === 'override') next = next.map(it => it.n === o.n ? { ...it, decision: 'approve', chosen: o.value } : it);
  }
  return next;
}

// Items the host approved → ready to send (a chosen price + a real recipient).
function approvedSendable(items) {
  return items.filter(it => it.decision === 'approve' && it.reservationId && it.chosen != null);
}

module.exports = {
  EARLY_CHECKIN_FEE, LATE_CHECKOUT_FEE, addDays, nightVacant, checkoutOn, checkinOn,
  detectExtension, detectEarlyCheckin, detectLateCheckout, detectGapFill, scanUnit,
  suggestPrice, buildDigestItems, formatDigest, parseDigestDecision, applyDecisions, approvedSendable,
  sameGuestStacks, sameGuestConflicts, nightBooked,
};
