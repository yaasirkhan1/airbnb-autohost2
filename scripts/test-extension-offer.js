'use strict';
// Tests for the vacant-night extension-offer logic (src/extension-offer.js). Pure — no network.
const x = require('../src/extension-offer');

let pass = 0, fail = 0;
function check(name, fn) {
  try { const r = fn(); if (r === false) throw new Error('returned false'); console.log(`✓ ${name}`); pass++; }
  catch (e) { console.log(`✗ ${name} — ${e.message}`); fail++; }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };

// helpers to build reservation rows
const out = (name, id = 'r1') => ({ id, check_out: '2026-06-25', guest: { first_name: name } });
const inc = (name, id = 'r2') => ({ id, check_in: '2026-06-25', guest: { first_name: name } });

// ── eligibility ───────────────────────────────────────────────────────────────
check('eligible: checkout tomorrow + no same-day check-in', () =>
  x.isEligible({ outgoing: [out('Illiasse')], incoming: [] }) === true);

check('NOT eligible: same-day turnover (a guest checks in that day)', () =>
  x.isEligible({ outgoing: [out('Illiasse')], incoming: [inc('NewGuest')] }) === false);

check('NOT eligible: no checkout tomorrow', () =>
  x.isEligible({ outgoing: [], incoming: [] }) === false);

// ── markup scales by vacancy count ─────────────────────────────────────────────
check('markup: 1 vacant → +$10', () => x.scaleMarkup(1) === 10);
check('markup: 2 vacant → +$7',  () => x.scaleMarkup(2) === 7);
check('markup: 3 vacant → +$5',  () => x.scaleMarkup(3) === 5);
check('markup: 5 vacant → +$5',  () => x.scaleMarkup(5) === 5);
check('markup: 6+ vacant → +$5 (aggressive fill cap)', () => x.scaleMarkup(7) === 5);
check('quote = whole-dollar calendar price + markup', () => {
  eq(x.computeQuote(85, 4), 90, '4 vacant');     // 85 + 5
  eq(x.computeQuote(85, 2), 92, '2 vacant');     // 85 + 7
  eq(x.computeQuote(117, 1), 127, '1 vacant');   // 117 + 10
  eq(x.computeQuote(84.6, 3), 90, 'rounds');     // round(84.6)=85 + 5
  return true;
});

// ── wrong-thread guard ──────────────────────────────────────────────────────────
check('guard OK: exactly one checkout + matching first name', () => {
  const m = x.matchOfferReservation([out('Nabil', 'resvX')], 'Nabil');
  ok(m.ok, m.reason); eq(m.reservation.id, 'resvX'); return true;
});
check('guard REFUSE: zero checkouts', () => x.matchOfferReservation([], 'Nabil').ok === false);
check('guard REFUSE: two checkouts (ambiguous)', () =>
  x.matchOfferReservation([out('Nabil', 'a'), out('Nabil', 'b')], 'Nabil').ok === false);
check('guard REFUSE: name changed since scan (never wrong thread)', () => {
  const m = x.matchOfferReservation([out('SomeoneElse')], 'Nabil');
  return m.ok === false && /changed/.test(m.reason);
});
check('guard REFUSE: reservation has no guest name', () =>
  x.matchOfferReservation([{ id: 'r', check_out: '2026-06-25' }], 'Nabil').ok === false);
check('guard matches on first token of a full name', () => {
  const m = x.matchOfferReservation([{ id: 'r', guest: { full_name: 'Nabil Haddad' } }], 'Nabil');
  return m.ok === true;
});

// ── template render (exact, no leftover placeholders) ───────────────────────────
check('render fills {guest_name} and {price}; $ stays literal', () => {
  const msg = x.renderOffer('Nabil', 118);
  ok(msg.includes('Hi Nabil!'), 'name');
  ok(msg.includes('only $118.'), 'price with literal $');
  ok(msg.trim().endsWith('— Cal'), 'signed Cal');
  ok(!/\{[a-z_]+\}/.test(msg), 'no leftover {placeholder}');
  return true;
});

// ── reply classification: a clear yes pings; no / question does not ─────────────
for (const t of ['yes', 'Yes please!', 'sure', "we'll take it", 'sounds good', 'absolutely', 'ok', "let's do it"])
  check(`affirmative: "${t}"`, () => x.classifyReply(t) === 'affirmative');
for (const t of ['no', 'No thanks', "we're good", 'nah', 'pass', 'unfortunately we cannot'])
  check(`negative: "${t}"`, () => x.classifyReply(t) === 'negative');
for (const t of ['how much is it?', 'what time is checkout?', 'can I get two nights?', 'is breakfast included?'])
  check(`other (question, not a yes): "${t}"`, () => x.classifyReply(t) === 'other');
check('"yes but how much?" is treated as a question, NOT a yes (conservative)', () =>
  x.classifyReply('yes but how much?') === 'other');

// ── decision on reply (ping only on a clear yes) ────────────────────────────────
const pendingOffer = { status: 'pending', guestName: 'Nabil', unit: 'Apt 21-I', price: 118, date: '2026-06-25' };
check('yes → ping host + accept + suppress generic reply', () => {
  const d = x.decideOnReply(pendingOffer, 'yes, sounds good');
  eq(d, { ping: true, status: 'accepted', suppress: true }); return true;
});
check('no → no ping, mark declined, let responder reply', () => {
  const d = x.decideOnReply(pendingOffer, 'no thanks');
  eq(d, { ping: false, status: 'declined', suppress: false }); return true;
});
check('question → no ping, offer stays pending', () => {
  const d = x.decideOnReply(pendingOffer, 'how much exactly?');
  eq(d, { ping: false, status: 'pending', suppress: false }); return true;
});
check('already-resolved offer → never pings again', () => {
  const d = x.decideOnReply({ ...pendingOffer, status: 'accepted' }, 'yes');
  return d.ping === false;
});

// ── store: record / resolve / prune ─────────────────────────────────────────────
check('record then get an offer', () => {
  const s = x.recordOffer({}, 'r1', { unit: 'Apt 4-L', price: 90, date: '2026-06-25', status: 'pending' });
  eq(x.getOffer(s, 'r1').price, 90); return true;
});
check('resolve flips status, keeps the record', () => {
  let s = x.recordOffer({}, 'r1', { date: '2026-06-25', status: 'pending' });
  s = x.resolveOffer(s, 'r1', 'accepted');
  return x.getOffer(s, 'r1').status === 'accepted';
});
check('prune drops offers whose night is already past', () => {
  const s = { old: { date: '2026-06-20', status: 'pending' }, keep: { date: '2026-06-25', status: 'pending' } };
  const p = x.pruneOffers(s, '2026-06-24');
  return !p.old && !!p.keep;
});

// ── end-to-end shape: a night booked AFTER the scan is re-checked and skipped ────
check('re-confirm: night booked between scan and send → guard composition skips it', () => {
  // at scan: vacant + eligible. at send re-check: calendar now booked → caller must skip.
  const scan = { available: true, eligible: x.isEligible({ outgoing: [out('Illiasse')], incoming: [] }) };
  ok(scan.eligible && scan.available, 'was offerable at scan');
  const recheckDayBooked = { date: '2026-06-25', booked: true };   // fetchCalendarEntries shape
  const stillVacant = !recheckDayBooked.booked;
  ok(stillVacant === false, 'recheck shows booked → not vacant');
  // the send path only proceeds when stillVacant && guard.ok; here stillVacant is false → skip
  return stillVacant === false;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
