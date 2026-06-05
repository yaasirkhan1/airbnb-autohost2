// Tests for the pricing safety guardrails. Run: node scripts/test-pricing-guards.js
'use strict';
const assert = require('assert');
const { computeNight } = require('../src/pricing-engine');
const { bookingStateFromCalDay, isNightBooked, isCalendarUsable, isPushable, etToday, runSanityCheck } = require('../src/pricing-guards');
const realConfig = require('../src/pricing-config.json');

let pass = 0; const ok = (n, f) => { f(); console.log('✓', n); pass++; };

// Minimal config for engine-behavior tests (overlap + clamp), independent of real config.
const cfg = (events) => ({
  units: { 'X': { type: '1BR', quality: 'ok', base: 100, floor: 60, ceiling: 300 } },
  seasonal: {}, dayOfWeek: {}, perUnitAdj: { ok: 0 },
  weekendFloor: { '1BR': 99, '2BR': 127 },
  decay: [{ daysOut: 30, mult: 1.0 }, { daysOut: 3, mult: 0.5 }], events,
});
const FAR = { todayYmd: '2026-01-01', isBooked: false };

// ── Guardrail 1: fail-closed fetch → unit skipped (isCalendarUsable) ──
ok('fetch-failure / empty / malformed calendar is NOT usable (unit gets skipped)', () => {
  assert.strictEqual(isCalendarUsable({ ok: false }), false);                       // fetch failed
  assert.strictEqual(isCalendarUsable({ ok: true, days: [] }), false);              // empty
  assert.strictEqual(isCalendarUsable({ ok: true, days: [{ foo: 1 }] }), false);    // malformed (no date)
  assert.strictEqual(isCalendarUsable(null), false);
  assert.strictEqual(isCalendarUsable({ ok: true, days: [{ date: '2026-10-21' }] }), true); // good
});

// ── Guardrail 2: unknown/ambiguous booking status → BOOKED (never decayed) ──
ok('unknown / missing booking status is treated as BOOKED (safe default)', () => {
  assert.strictEqual(bookingStateFromCalDay({ status: { available: true } }), 'available');
  assert.strictEqual(bookingStateFromCalDay({ status: { available: false } }), 'booked');
  assert.strictEqual(bookingStateFromCalDay({ status: {} }), 'booked');   // ambiguous
  assert.strictEqual(bookingStateFromCalDay({}), 'booked');               // no status
  assert.strictEqual(bookingStateFromCalDay(undefined), 'booked');        // missing day
  assert.strictEqual(isNightBooked(undefined), true);
  assert.strictEqual(isNightBooked({ status: { available: true } }), false);
});

// ── Guardrail 3: oversized run halts ──
ok('runSanityCheck halts when >threshold% of nights change', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ oldPrice: 100, newPrice: i < 9 ? 110 : 100 }); // 90% changed, +10% moves
  const r = runSanityCheck(rows, { maxChangedPct: 80, maxMovePct: 60 });
  assert.strictEqual(r.halt, true);
  assert.ok(r.reasons.some(x => /of nights would change/.test(x)));
});
ok('runSanityCheck halts when any single move exceeds threshold', () => {
  const rows = [{ oldPrice: 100, newPrice: 100 }, { oldPrice: 100, newPrice: 175 }]; // 1 of 2 changed (50%) but +75% move
  const r = runSanityCheck(rows, { maxChangedPct: 80, maxMovePct: 60 });
  assert.strictEqual(r.halt, true);
  assert.ok(r.reasons.some(x => /single price move/.test(x)));
});
ok('runSanityCheck passes on a normal run', () => {
  const rows = [{ oldPrice: 100, newPrice: 100 }, { oldPrice: 100, newPrice: 105 }, { oldPrice: 100, newPrice: 100 }];
  const r = runSanityCheck(rows, { maxChangedPct: 80, maxMovePct: 60 });
  assert.strictEqual(r.halt, false);
});

// ── Guardrail 4: overlap → higher resulting price wins (order-independent) ──
ok('overlap: higher-priced event wins regardless of config order', () => {
  // "high" set $250 vs "low" mult 1.2 (=$120 on base 100). High must win even when listed first.
  const events = [
    { name: 'high', start: '2026-10-10', end: '2026-10-20', priceMode: 'set', price1BR: 250 },
    { name: 'low',  start: '2026-10-10', end: '2026-10-20', priceMode: 'mult', mult: 1.2 },
  ];
  const r = computeNight(cfg(events), 'X', '2026-10-15', FAR);
  assert.strictEqual(r.event, 'high');
  assert.strictEqual(r.price, 250);
  assert.ok(r.overlaps && r.overlaps.length === 2, 'overlap alternatives surfaced');
  // reverse order → same winner
  const r2 = computeNight(cfg([events[1], events[0]]), 'X', '2026-10-15', FAR);
  assert.strictEqual(r2.event, 'high');
  assert.strictEqual(r2.price, 250);
});
ok('overlap on real config: Dragon Con set-$500 beats Bridge Regional mult on 4-L', () => {
  const r = computeNight(realConfig, '4-L', '2026-09-04', FAR); // Bridge(1.8) + Dragon Con(set 500) overlap
  assert.strictEqual(r.price, 500);
  assert.ok(/dragon con/i.test(r.event));
  assert.ok(r.overlaps && r.overlaps.length >= 2);
});

// ── Guardrail 6: floor/ceiling clamp applies to EVENT prices too ──
ok('event set-price above ceiling is clamped to ceiling', () => {
  const r = computeNight(cfg([{ name: 'huge', start: '2026-10-10', end: '2026-10-20', priceMode: 'set', price1BR: 9999 }]), 'X', '2026-10-15', FAR);
  assert.strictEqual(r.price, 300, `should clamp to ceiling 300, got ${r.price}`);
});
ok('event set-price below floor is clamped up to hard floor', () => {
  const r = computeNight(cfg([{ name: 'tiny', start: '2026-10-10', end: '2026-10-20', priceMode: 'set', price1BR: 5 }]), 'X', '2026-10-15', FAR);
  assert.strictEqual(r.price, 60, `should clamp to floor 60, got ${r.price}`);
});

// ── Fix #4: booked nights are NEVER pushable (absent from push rows) ──
ok('(#4) booked night is excluded from the push queue (skip too)', () => {
  assert.strictEqual(isPushable({ skip: false }, true), false, 'booked must not be pushable');
  assert.strictEqual(isPushable({ skip: true }, false), false, 'skip must not be pushable');
  assert.strictEqual(isPushable({ skip: false }, false), true, 'normal night is pushable');
  // end-to-end on the engine path: a booked night still computes a price, but the runner's
  // gate (isPushable) keeps it out of rows. Prove the gate rejects it.
  const res = computeNight(cfg([]), 'X', '2026-10-21', { todayYmd: '2026-10-15', isBooked: true });
  assert.ok(res.price != null);                 // engine still returns a number
  assert.strictEqual(isPushable(res, true), false); // ...but it is NOT pushable
});

// ── Fix #7: null / low-coverage current data HALTS ──
ok('(#7) all-null current prices HALT (not "0% changed → safe")', () => {
  const r = runSanityCheck([{ oldPrice: null, newPrice: 84 }, { oldPrice: null, newPrice: 99 }], {});
  assert.strictEqual(r.halt, true);
  assert.ok(r.reasons.some(x => /coverage/.test(x)));
});
ok('(#7) coverage below 50% HALTs', () => {
  const rows = [{ oldPrice: 100, newPrice: 100 }, { oldPrice: null, newPrice: 90 }, { oldPrice: null, newPrice: 90 }]; // 33% coverage
  const r = runSanityCheck(rows, { minCoveragePct: 50 });
  assert.strictEqual(r.halt, true);
  assert.ok(r.reasons.some(x => /coverage/.test(x)));
});
ok('(#7) full coverage, small moves → no halt', () => {
  const r = runSanityCheck([{ oldPrice: 100, newPrice: 100 }, { oldPrice: 100, newPrice: 105 }], { minCoveragePct: 50 });
  assert.strictEqual(r.halt, false);
});

// ── Fix #6: today anchored to America/New_York, not UTC ──
ok('(#6) etToday resolves a late-ET instant to the correct ET date (not next UTC day)', () => {
  // 2026-06-05T01:30Z == 2026-06-04 21:30 ET → ET date must be 06-04
  assert.strictEqual(etToday(new Date('2026-06-05T01:30:00Z')), '2026-06-04');
  // midday is unambiguous
  assert.strictEqual(etToday(new Date('2026-06-05T16:00:00Z')), '2026-06-05');
});

// ── Fix #1: event price outside [floor,ceiling] is flagged (clamped.onEvent) ──
ok('(#1) event set-price above ceiling is clamped AND flagged (onEvent)', () => {
  const r = computeNight(cfg([{ name: 'huge', start: '2026-10-10', end: '2026-10-20', priceMode: 'set', price1BR: 9999 }]), 'X', '2026-10-15', FAR);
  assert.strictEqual(r.price, 300);
  assert.ok(r.clamped && r.clamped.onEvent === true && r.clamped.bound === 'ceiling' && r.clamped.from === 9999);
});
ok('(#1) routine decay-to-floor on a NON-event night is not flagged as an event clamp', () => {
  // deep decay below floor on a normal weekday → clamps to floor but onEvent=false
  const r = computeNight(cfg([]), 'X', '2026-10-19', { todayYmd: '2026-10-18', isBooked: false }); // 1 day out, mult well below
  if (r.clamped) assert.strictEqual(r.clamped.onEvent, false);
});

// ── Weekend floor is a HARD floor: a vacant last-minute Fri/Sat never decays below it ──
ok('weekend HARD floor: empty Fri/Sat hold $99 (1BR) / $127 (2BR) at ANY lead time (no release)', () => {
  // 2026-06-05 is Fri, 06-06 Sat, no event; decayed base is far below the weekend floor.
  for (const today of ['2026-06-05', '2026-06-04', '2026-05-07']) { // leadDays 0, 1, 29 — all must hold
    const fri = computeNight(realConfig, '23-N', '2026-06-05', { todayYmd: today, isBooked: false });
    const sat = computeNight(realConfig, '23-N', '2026-06-06', { todayYmd: today, isBooked: false });
    assert.strictEqual(fri.price, 99, `23-N Fri @${today} must hold weekend floor 99, got ${fri.price}`);
    assert.strictEqual(sat.price, 99, `23-N Sat @${today} must hold weekend floor 99, got ${sat.price}`);
    assert.strictEqual(fri.floorUsed, 99, `23-N Fri @${today} floorUsed must be the weekend floor`);
  }
  // 2BR weekend floor $127, last-minute (leadDays 0) vacant Saturday
  const sat2 = computeNight(realConfig, '21-I', '2026-06-06', { todayYmd: '2026-06-06', isBooked: false });
  assert.strictEqual(sat2.price, 127, `21-I 2BR last-minute Sat must hold weekend floor 127, got ${sat2.price}`);
  assert.strictEqual(sat2.floorUsed, 127);
  // weekday is unaffected — a vacant Monday may still decay below the weekend floor to its hard floor
  const mon = computeNight(realConfig, '23-N', '2026-06-08', { todayYmd: '2026-06-08', isBooked: false });
  assert.ok(mon.price < 99, `Mon should be allowed below 99 (weekend rule is weekend-only), got ${mon.price}`);
});

console.log(`\n${pass} passed`);
