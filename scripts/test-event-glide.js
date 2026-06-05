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

// ── Bridge Regional is now Tier 1 (142→117), ease 7, on a Bridge-only night (Sep 1–2) ──
ok('Bridge Regional 1BR Tier-1 glide 142→117 on Sep 1 (Bridge-only)', () => {
  assert.ok(/bridge/i.test(at('23-N', '2026-09-01', 7).event));
  assert.strictEqual(at('23-N', '2026-09-01', 7).price, 142);
  assert.strictEqual(at('23-N', '2026-09-01', 0).price, 117);
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
  assert.strictEqual(at('23-N', '2026-12-31', 6).minStay, 3);  // inside ease (7) → low
  assert.strictEqual(at('23-N', '2026-12-31', 0).price, 132);
});

// ── AmericasMart Winter 2027: glide 199→145, min 8→5 ──
ok('AmericasMart 1BR glide 199→145 with min 8→5 relax', () => {
  assert.strictEqual(at('23-N', '2027-01-14', 40).price, 199);
  assert.strictEqual(at('23-N', '2027-01-14', 40).minStay, 8);
  assert.strictEqual(at('23-N', '2027-01-14', 6).minStay, 5); // inside ease (7) → low
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
ok('World Cup is now MANAGED as glide (skip removed) — window nights price, no skip', () => {
  const r = computeNight(cfg, '23-N', '2026-06-20', { todayYmd: '2026-06-01', isBooked: false });
  assert.strictEqual(r.skip, undefined, 'WC no longer hard-skips');
  assert.ok(r.price >= 99, 'WC night now prices at/above the floor');
  // (detailed WC tier behavior is covered by scripts/test-wc-glide.js)
});

// ── Weekend hard floor holds on EVENT nights too (now all event floors are >= $99/$127, but
//    a Tier-3 event easing to its $99 floor on a weekend must still never dip below $99) ──
ok('event-night weekend never drops below $99 (Tier-3 eases to exactly the $99 floor)', () => {
  // Falcons vs Bears (Tier 3, 1BR floor $99) on a near date → eases to $99, never below.
  for (const lead of [7, 3, 1, 0]) {
    const r = at('23-N', '2026-10-18', lead);
    assert.ok(r.price >= 99, `Tier-3 event night >= 99 (lead ${lead} → $${r.price})`);
  }
  // every glide event floor sits at/above the weekend hard floor (config-level invariant)
  for (const e of cfg.events.filter(e => e.priceMode === 'glide')) {
    assert.ok(e.floor1BR >= 99, `${e.name}: floor1BR ${e.floor1BR} >= 99`);
    assert.ok(e.floor2BR == null || e.floor2BR >= 127, `${e.name}: floor2BR ${e.floor2BR} >= 127`);
  }
});
ok('the fix does NOT lower events already above the floor (Dragon Con Sat stays $500)', () => {
  // Sep 5 2026 is a Saturday inside Dragon Con; far out → startPrice
  const r = computeNight(cfg, '23-N', '2026-09-05', { todayYmd: '2026-08-05', isBooked: false });
  assert.ok(/dragon con/i.test(r.event));
  assert.strictEqual(r.price, 500, 'Dragon Con Saturday unchanged at $500');
});

console.log(`\n${pass}/${pass} passed`);
