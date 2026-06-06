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

ok('non-match glide 158→132 (1BR) / 213→178 (2BR), min 2→1', () => {
  // Jun 29 is a true non-match night (not a match, not a shoulder).
  assert.strictEqual(at('23-N', '2026-06-29', 7).price, 158);
  assert.strictEqual(at('23-N', '2026-06-29', 0).price, 132);
  assert.strictEqual(at('21-I', '2026-06-29', 7).price, 213);
  assert.strictEqual(at('21-I', '2026-06-29', 0).price, 178);
  assert.strictEqual(at('23-N', '2026-06-29', 7).minStay, 2);
  assert.strictEqual(at('23-N', '2026-06-29', 6).minStay, 1);
});

ok('group match (Jun 18) 176→166 / 238→224, min 2→1; higher-wins over baseline', () => {
  const r = at('23-N', '2026-06-18', 7);
  assert.strictEqual(r.price, 176); assert.ok(/group/i.test(r.event), 'match tier wins over baseline');
  assert.strictEqual(at('23-N', '2026-06-18', 0).price, 166);
  assert.strictEqual(at('21-I', '2026-06-18', 7).price, 238);
  assert.strictEqual(at('21-I', '2026-06-18', 0).price, 224);
});

ok('knockout (Jul 1, Jul 7) 300→250 / 380→338', () => {
  assert.strictEqual(at('23-N', '2026-07-01', 7).price, 300);
  assert.strictEqual(at('23-N', '2026-07-07', 0).price, 250);
  assert.strictEqual(at('21-I', '2026-07-01', 7).price, 380);
  assert.strictEqual(at('21-I', '2026-07-07', 0).price, 338);
  assert.ok(/knockout/i.test(at('23-N', '2026-07-01', 7).event));
});

ok('semifinal (Jul 15) 375→350 / 475→420, min 2→1 (WC rule)', () => {
  assert.strictEqual(at('23-N', '2026-07-15', 7).price, 375);
  assert.strictEqual(at('23-N', '2026-07-15', 0).price, 350);
  assert.strictEqual(at('21-I', '2026-07-15', 7).price, 475);
  assert.strictEqual(at('21-I', '2026-07-15', 0).price, 420);
  assert.strictEqual(at('23-N', '2026-07-15', 0).minStay, 1);
  assert.strictEqual(at('23-N', '2026-07-15', 7).minStay, 2);
});

ok('weekend hard floor holds inside WC (non-match Sat never below $99/$127)', () => {
  // 2026-06-20 is a Saturday shoulder → glide floor $145 (1BR) / $196 (2BR), both >= weekend floor
  assert.ok(at('23-N', '2026-06-20', 0).price >= 99);
  assert.ok(at('21-I', '2026-06-20', 0).price >= 127);
});

ok('booked WC night is frozen (not pushable); unbooked is pushable', () => {
  assert.strictEqual(isPushable(at('23-N', '2026-07-15', 5, true), true), false);
  assert.strictEqual(isPushable(at('23-N', '2026-07-15', 5, false), false), true);
});

ok('overlap: Jul 6 shoulder ($167) beats both baseline and Ariana Grande; Jul 7 knockout beats all', () => {
  // Jul 6 is shoulder (pre Jul 7 knockout): $167 > baseline $158 > Ariana $132
  assert.ok(/shoulder/i.test(at('23-N', '2026-07-06', 7).event), 'Jul 6: shoulder ($167) wins');
  assert.strictEqual(at('23-N', '2026-07-06', 7).price, 167);
  assert.ok(/knockout/i.test(at('23-N', '2026-07-07', 7).event), 'Jul 7: knockout ($300) > all');
});

ok('shoulder glide 167→145 (1BR) / 225→196 (2BR), min 2→1', () => {
  // Jun 16 = shoulder (post Jun 15 match). start at lead>=ease, floor at lead 0.
  assert.strictEqual(at('23-N', '2026-06-16', 7).price, 167);
  assert.strictEqual(at('23-N', '2026-06-16', 0).price, 145);
  assert.strictEqual(at('21-I', '2026-06-16', 7).price, 225);
  assert.strictEqual(at('21-I', '2026-06-16', 0).price, 196);
  assert.strictEqual(at('23-N', '2026-06-16', 7).minStay, 2);
  assert.strictEqual(at('23-N', '2026-06-16', 6).minStay, 1);
  assert.ok(/shoulder/i.test(at('23-N', '2026-06-16', 7).event), 'tier is shoulder');
});

ok('every match night still beats its adjacent shoulder (match wins overlap)', () => {
  // (matchDate, [shoulderBefore, shoulderAfter])
  const pairs = [
    ['2026-06-15', ['2026-06-14', '2026-06-16']],
    ['2026-06-18', ['2026-06-17', '2026-06-19']],
    ['2026-06-21', ['2026-06-20', '2026-06-22']],
    ['2026-06-24', ['2026-06-23', '2026-06-25']],
    ['2026-06-27', ['2026-06-26', '2026-06-28']],
    ['2026-07-01', ['2026-06-30', '2026-07-02']],
    ['2026-07-07', ['2026-07-06', '2026-07-08']],
    ['2026-07-15', ['2026-07-14', '2026-07-16']],
  ];
  for (const [m, shs] of pairs) {
    const mp = at('23-N', m, 7).price;
    assert.ok(!/shoulder/i.test(at('23-N', m, 7).event), `${m} must be a match tier, not shoulder`);
    for (const s of shs) {
      const sp = at('23-N', s, 7).price;
      assert.ok(/shoulder/i.test(at('23-N', s, 7).event), `${s} must be a shoulder`);
      assert.ok(mp > sp, `match ${m} ($${mp}) must beat adjacent shoulder ${s} ($${sp})`);
    }
  }
});

ok('price ladder is monotonic at start (lead 7) and floor (lead 0): nonmatch<shoulder<group<knockout<semifinal', () => {
  const rep = { nonmatch: '2026-06-29', shoulder: '2026-06-16', group: '2026-06-18', knockout: '2026-07-01', semifinal: '2026-07-15' };
  for (const lead of [7, 0]) {
    const order = ['nonmatch', 'shoulder', 'group', 'knockout', 'semifinal'].map(k => at('23-N', rep[k], lead).price);
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], `lead ${lead}: ${order.join(' < ')} not strictly increasing at index ${i}`);
    }
  }
});

ok('non-match in-between nights remain $158→$132 (unchanged by shoulder tier)', () => {
  // Jun 29 and Jul 3 are neither match nor shoulder → still baseline.
  assert.strictEqual(at('23-N', '2026-06-29', 7).price, 158);
  assert.strictEqual(at('23-N', '2026-06-29', 0).price, 132);
  assert.ok(/non-match/i.test(at('23-N', '2026-07-03', 7).event), 'Jul 3 stays non-match baseline');
});

console.log(`\n${pass}/${pass} passed`);
