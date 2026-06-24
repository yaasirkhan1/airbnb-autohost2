// Verifies the July-only WC daily-decay config change (option b): per-night easeStartDays so each
// unbooked July 1-7 night decays gently from TODAY (no initial jump), floored at each event's own
// floor, booked nights untouched, and June left unaffected.
// Run: node scripts/test-wc-july-daily-decay.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const { computeNight } = require('../src/pricing-engine');

const config = JSON.parse(fs.readFileSync(__dirname + '/../src/pricing-config.json', 'utf8'));
const TODAY = '2026-06-23'; // the day the per-night ease values are anchored to (lead = days-out)
const U = '4-L';            // any 1BR (glide prices are uniform across 1BR units)

let pass = 0;
const ok = (n, f) => { f(); console.log('✓', n); pass++; };
const price = (unit, date, today, isBooked = false) => computeNight(config, unit, date, { todayYmd: today, isBooked }).price;

// July 1-7: (date, startPrice1BR, floor1BR)
const JULY = [
  ['2026-07-01', 300, 250], ['2026-07-02', 167, 145], ['2026-07-03', 158, 132],
  ['2026-07-04', 158, 132], ['2026-07-05', 158, 132], ['2026-07-06', 167, 145],
  ['2026-07-07', 300, 250],
];

ok('NO initial jump today — every July 1-7 night sits at its start price', () => {
  for (const [d, start] of JULY) {
    assert.strictEqual(Math.round(price(U, d, TODAY)), start, `${d} should hold start $${start} today`);
  }
});

ok('it decays the very next day (no flat hold) and stays above floor', () => {
  for (const [d, start, floor] of JULY) {
    const p = price(U, d, '2026-06-24'); // one day later
    assert.ok(p < start, `${d}: should have dropped below $${start} by tomorrow (got $${Math.round(p)})`);
    assert.ok(p > floor, `${d}: should still be above floor $${floor} (got $${Math.round(p)})`);
  }
});

ok('each night lands exactly on its event floor on the date itself (never below)', () => {
  for (const [d, , floor] of JULY) {
    assert.strictEqual(Math.round(price(U, d, d)), floor, `${d} should bottom at floor $${floor}`);
  }
});

ok('the descent is monotonic, day by day, from today to the date', () => {
  const days = ['2026-06-23','2026-06-24','2026-06-25','2026-06-26','2026-06-27','2026-06-28','2026-06-29','2026-06-30','2026-07-01'];
  let prev = Infinity;
  for (const today of days) {
    const p = price(U, '2026-07-01', today);
    assert.ok(p <= prev + 0.001, `Jul 1 price must not rise: ${today} -> $${Math.round(p)} (prev $${Math.round(prev)})`);
    prev = p;
  }
});

ok('2BR (21-I) follows its own start/floor (380 -> 338) with no jump', () => {
  assert.strictEqual(Math.round(price('21-I', '2026-07-01', TODAY)), 380, 'no jump today');
  assert.strictEqual(Math.round(price('21-I', '2026-07-01', '2026-07-01')), 338, 'bottoms at 2BR floor');
});

ok('BOOKED nights are flagged booked (the runner skips booked — never repriced)', () => {
  const r = computeNight(config, U, '2026-07-01', { todayYmd: '2026-06-26', isBooked: true });
  assert.strictEqual(r.booked, true, 'booked flag propagates so the push step skips it');
});

ok('JUNE is unaffected — June baseline still holds at ease 7', () => {
  const r = computeNight(config, U, '2026-06-29', { todayYmd: '2026-01-01' }); // baseline-only June night, far out
  assert.ok(/Jun 14-30/.test(r.event || ''), `June night should use the June baseline event (got "${r.event}")`);
  assert.strictEqual(r.layers.eventGlide.easeStartDays, 7, 'June baseline ease must stay 7');
  assert.strictEqual(Math.round(r.price), 158, 'June baseline holds start price far out (unchanged)');
});

ok('Jul 1/7 governed by the marquee; Jul 3 by the new per-date baseline', () => {
  assert.ok(/marquee Jul 1/.test(computeNight(config, U, '2026-07-01', { todayYmd: TODAY }).event));
  assert.ok(/baseline Jul 3/.test(computeNight(config, U, '2026-07-03', { todayYmd: TODAY }).event));
});

console.log(`\n${pass} passed`);
