// Tests for the World Cup glide tiers (skip removed → managed as glide). Run: node scripts/test-wc-glide.js
'use strict';
const assert = require('assert');
const { computeNight } = require('../src/pricing-engine');
const { isPushable } = require('../src/pricing-guards');
const cfg = require('../src/pricing-config.json');

let pass = 0; const ok = (n, f) => { f(); console.log('✓', n); pass++; };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = (unit, night, lead, booked = false) => computeNight(cfg, unit, night, { todayYmd: addDays(night, -lead), isBooked: booked });

ok('WC is no longer a hard-skip — every window night now prices', () => {
  for (const d of ['2026-06-14', '2026-06-20', '2026-07-04', '2026-07-16']) {
    const r = computeNight(cfg, '23-N', d, { todayYmd: '2026-06-01', isBooked: false });
    assert.strictEqual(r.skip, undefined, `${d} must not skip`);
    assert.ok(r.price > 0, `${d} priced`);
  }
});

ok('non-match glide 130→99 (1BR) / 170→134 (2BR), min 2→1', () => {
  assert.strictEqual(at('23-N', '2026-06-16', 7).price, 130);
  assert.strictEqual(at('23-N', '2026-06-16', 0).price, 99);
  assert.strictEqual(at('21-I', '2026-06-16', 7).price, 170);
  assert.strictEqual(at('21-I', '2026-06-16', 0).price, 134);
  assert.strictEqual(at('23-N', '2026-06-16', 7).minStay, 2);
  assert.strictEqual(at('23-N', '2026-06-16', 6).minStay, 1);
});

ok('group match (Jun 18) 200→189 / 280→255, min 2→1; higher-wins over baseline', () => {
  const r = at('23-N', '2026-06-18', 7);
  assert.strictEqual(r.price, 200); assert.ok(/group/i.test(r.event), 'match tier wins over baseline');
  assert.strictEqual(at('23-N', '2026-06-18', 0).price, 189);
  assert.strictEqual(at('21-I', '2026-06-18', 7).price, 280);
  assert.strictEqual(at('21-I', '2026-06-18', 0).price, 255);
});

ok('knockout (Jul 1, Jul 7) 300→189 / 380→255', () => {
  assert.strictEqual(at('23-N', '2026-07-01', 7).price, 300);
  assert.strictEqual(at('23-N', '2026-07-07', 0).price, 189);
  assert.strictEqual(at('21-I', '2026-07-01', 7).price, 380);
  assert.strictEqual(at('21-I', '2026-07-07', 0).price, 255);
  assert.ok(/knockout/i.test(at('23-N', '2026-07-01', 7).event));
});

ok('semifinal (Jul 15) 375→350 / 475→420, min 2 hold', () => {
  assert.strictEqual(at('23-N', '2026-07-15', 7).price, 375);
  assert.strictEqual(at('23-N', '2026-07-15', 0).price, 350);
  assert.strictEqual(at('21-I', '2026-07-15', 7).price, 475);
  assert.strictEqual(at('21-I', '2026-07-15', 0).price, 420);
  assert.strictEqual(at('23-N', '2026-07-15', 0).minStay, 2);
  assert.strictEqual(at('23-N', '2026-07-15', 7).minStay, 2);
});

ok('weekend hard floor holds inside WC (non-match Sat never below $99/$127)', () => {
  // 2026-06-20 is a Saturday, non-match → glide floor $99 (1BR) / $134 (2BR), both >= weekend floor
  assert.ok(at('23-N', '2026-06-20', 0).price >= 99);
  assert.ok(at('21-I', '2026-06-20', 0).price >= 127);
});

ok('booked WC night is frozen (not pushable); unbooked is pushable', () => {
  assert.strictEqual(isPushable(at('23-N', '2026-07-15', 5, true), true), false);
  assert.strictEqual(isPushable(at('23-N', '2026-07-15', 5, false), false), true);
});

ok('overlap: Ariana Grande (Jul 6-8) beats baseline; Jul 7 knockout beats Ariana', () => {
  assert.ok(/ariana/i.test(at('23-N', '2026-07-06', 7).event), 'Jul 6: Ariana ($132) > baseline ($130)');
  assert.ok(/knockout/i.test(at('23-N', '2026-07-07', 7).event), 'Jul 7: knockout ($300) > Ariana');
});

console.log(`\n${pass}/${pass} passed`);
