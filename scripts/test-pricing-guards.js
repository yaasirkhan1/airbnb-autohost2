// Tests for the pricing safety guardrails. Run: node scripts/test-pricing-guards.js
'use strict';
const assert = require('assert');
const { computeNight } = require('../src/pricing-engine');
const { bookingStateFromCalDay, isNightBooked, isCalendarUsable, runSanityCheck } = require('../src/pricing-guards');
const realConfig = require('../src/pricing-config.json');

let pass = 0; const ok = (n, f) => { f(); console.log('✓', n); pass++; };

// Minimal config for engine-behavior tests (overlap + clamp), independent of real config.
const cfg = (events) => ({
  units: { 'X': { type: '1BR', quality: 'ok', base: 100, floor: 60, ceiling: 300 } },
  seasonal: {}, dayOfWeek: {}, perUnitAdj: { ok: 0 },
  softWeekendFloor: { '1BR': 99, '2BR': 127 }, softFloorReleaseDaysOut: 2,
  decay: [{ daysOut: 30, mult: 1.0 }], events,
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

console.log(`\n${pass} passed`);
