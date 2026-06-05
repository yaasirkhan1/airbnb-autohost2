// Tests for the per-event daily-glide feature. Run: node scripts/test-event-glide.js
'use strict';
const assert = require('assert');
const { computeNight, glidePrice, glideMinStay } = require('../src/pricing-engine');
const { isPushable } = require('../src/pricing-guards');
const cfg = require('../src/pricing-config.json');

let pass = 0; const ok = (n, f) => { f(); console.log('✓', n); pass++; };

// night - lead days = the "today" that yields that leadDays for the night
const todayFor = (night, lead) => { const d = new Date(night + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - lead); return d.toISOString().slice(0, 10); };
const at = (unit, night, lead, booked = false) => computeNight(cfg, unit, night, { todayYmd: todayFor(night, lead), isBooked: booked });

// ── pure glide math ──
ok('glidePrice: linear startPrice→floor over easeStartDays; clamps outside', () => {
  assert.strictEqual(glidePrice(500, 320, 30, 30), 500);   // at ease
  assert.strictEqual(glidePrice(500, 320, 30, 40), 500);   // beyond ease → start
  assert.strictEqual(glidePrice(500, 320, 30, 0), 320);    // event date → floor
  assert.strictEqual(glidePrice(500, 320, 30, -5), 320);   // past → floor, never below
  assert.strictEqual(Math.round(glidePrice(500, 320, 30, 15)), 410); // midpoint
});
ok('glideMinStay: high far out, low inside the ease window', () => {
  assert.strictEqual(glideMinStay(8, 5, 30, 40), 8);
  assert.strictEqual(glideMinStay(8, 5, 30, 30), 8);
  assert.strictEqual(glideMinStay(8, 5, 30, 29), 5);
  assert.strictEqual(glideMinStay(5, 5, 30, 0), 5); // hold
});

// ── Dragon Con 23-N (1BR): day-by-day glide 500 → 320, min 5 hold ──
ok('Dragon Con 1BR day-by-day glide 500→320 (monotonic, never below floor, min 5)', () => {
  let prev = Infinity;
  for (const lead of [40, 30, 21, 14, 7, 3, 1, 0]) {
    const r = at('23-N', '2026-09-04', lead);
    assert.ok(/dragon con/i.test(r.event), 'event = Dragon Con');
    assert.ok(r.price >= 320, `never below floor 320 (lead ${lead} → ${r.price})`);
    assert.ok(r.price <= 500, 'never above start 500');
    assert.ok(r.price <= prev, `monotonic non-increasing as date nears (lead ${lead})`); prev = r.price;
    assert.strictEqual(r.minStay, 5, 'min 5 hold');
  }
  assert.strictEqual(at('23-N', '2026-09-04', 30).price, 500);
  assert.strictEqual(at('23-N', '2026-09-04', 0).price, 320);
});

// ── Dragon Con 2BR (21-I): 695 → 386 ──
ok('Dragon Con 2BR glide 695→386', () => {
  assert.strictEqual(at('21-I', '2026-09-04', 30).price, 695);
  assert.strictEqual(at('21-I', '2026-09-04', 0).price, 386);
});

// ── Bridge Regional 23-N: 179 → 125, on a Bridge-only night (Sep 1–2) ──
ok('Bridge Regional 1BR glide 179→125 on Sep 1 (Bridge-only)', () => {
  assert.ok(/bridge/i.test(at('23-N', '2026-09-01', 30).event));
  assert.strictEqual(at('23-N', '2026-09-01', 30).price, 179);
  assert.strictEqual(at('23-N', '2026-09-01', 0).price, 125);
});

// ── Overlap Sep 3–7: Dragon Con (higher) wins over Bridge at every lead ──
ok('Dragon Con + Bridge overlap (Sep 3–7): higher price (Dragon Con) wins', () => {
  for (const lead of [30, 14, 0]) {
    const r = at('23-N', '2026-09-05', lead);
    assert.ok(/dragon con/i.test(r.event), `Dragon Con wins at lead ${lead}`);
    assert.ok(r.overlaps && r.overlaps.length >= 2, 'overlap surfaced');
  }
});

// ── NYE: glide 157→132, min relax 4→3 ──
ok('NYE 1BR glide 157→132 with min 4→3 relax', () => {
  assert.strictEqual(at('23-N', '2026-12-31', 40).price, 157);
  assert.strictEqual(at('23-N', '2026-12-31', 40).minStay, 4); // far → high
  assert.strictEqual(at('23-N', '2026-12-31', 29).minStay, 3); // inside ease → low
  assert.strictEqual(at('23-N', '2026-12-31', 0).price, 132);
});

// ── AmericasMart Winter 2027: glide 199→145, min 8→5 ──
ok('AmericasMart 1BR glide 199→145 with min 8→5 relax', () => {
  assert.strictEqual(at('23-N', '2027-01-14', 40).price, 199);
  assert.strictEqual(at('23-N', '2027-01-14', 40).minStay, 8);
  assert.strictEqual(at('23-N', '2027-01-14', 29).minStay, 5);
  assert.strictEqual(at('23-N', '2027-01-14', 0).price, 145);
});

// ── Booked nights frozen: a booked glide night is NEVER pushable (runner leaves it = frozen) ──
ok('booked glide night is not pushable (frozen at sold price)', () => {
  const r = at('23-N', '2026-09-04', 14, /*booked*/ true);
  assert.strictEqual(r.booked, true);
  assert.strictEqual(isPushable(r, true), false, 'booked night must not enter the push queue');
  // an unbooked same night IS pushable
  assert.strictEqual(isPushable(at('23-N', '2026-09-04', 14, false), false), true);
});

// ── Floors / regressions preserved ──
ok('never below event floor even past the date', () => {
  assert.strictEqual(at('23-N', '2026-09-04', -10).price, 320); // past event date → floor, not below
});
ok('weekend HARD floor $99 still intact on a NON-event weekend', () => {
  // 2026-08-22 Sat, no event, last-minute vacant → $99 (regression)
  assert.strictEqual(computeNight(cfg, '23-N', '2026-08-22', { todayYmd: '2026-08-22', isBooked: false }).price, 99);
});
ok('World Cup SKIP still intact (engine writes nothing)', () => {
  const r = computeNight(cfg, '23-N', '2026-06-20', { todayYmd: '2026-06-01', isBooked: false });
  assert.strictEqual(r.skip, true);
  assert.strictEqual(r.price, null);
});

// ── BUGFIX: weekend hard floor must hold on EVENT nights too (weak mult can't drag below $99) ──
ok('weak-multiplier-event Friday on cheapest unit (23-N) never drops below $99', () => {
  // 2026-08-07 Fri is inside "August Apparel+Formal" (mult 1.25) — it computed $82 before the fix.
  const r = computeNight(cfg, '23-N', '2026-08-07', { todayYmd: '2026-06-05', isBooked: false });
  assert.ok(r.event && /apparel/i.test(r.event), 'is a multiplier-event night');
  assert.strictEqual(r.price, 99, `weekend floor must hold (got $${r.price})`);
  assert.ok(r.clamped && r.clamped.bound === 'floor' && r.clamped.onEvent === true, 'clamp-up is recorded (loud)');
  // and the same scan-flagged nights:
  assert.ok(computeNight(cfg, '23-N', '2026-09-26', { todayYmd: '2026-06-05', isBooked: false }).price >= 99, 'Sep 26 (Collect-A-Con Sat) >= 99');
  assert.ok(computeNight(cfg, '23-N', '2026-10-09', { todayYmd: '2026-06-05', isBooked: false }).price >= 99, 'Oct 9 (October Apparel Fri) >= 99');
});
ok('the fix does NOT lower events already above the floor (Dragon Con Sat stays $500)', () => {
  // Sep 5 2026 is a Saturday inside Dragon Con; far out → startPrice
  const r = computeNight(cfg, '23-N', '2026-09-05', { todayYmd: '2026-08-05', isBooked: false });
  assert.ok(/dragon con/i.test(r.event));
  assert.strictEqual(r.price, 500, 'Dragon Con Saturday unchanged at $500');
});

console.log(`\n${pass}/${pass} passed`);
