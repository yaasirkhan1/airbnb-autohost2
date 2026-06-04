// pricing-engine.test.js  — run: node pricing-engine.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const { computeNight, resolveMinStay, decayMult } = require('./pricing-engine');

const config = JSON.parse(fs.readFileSync(__dirname + '/pricing-config.json', 'utf8'));
let pass = 0;
const ok = (n, f) => { f(); console.log('\u2713', n); pass++; };

// Use a fixed "today" far before all dates so decay = far-out (mult 1.0) unless overridden.
const FAR = { todayYmd: '2026-01-01', isBooked: false };

ok('normal weekday near base (no event)', () => {
  // 23-N base 74, October (0%), pick a normal Wednesday with no event
  const r = computeNight(config, '23-N', '2026-10-21', FAR); // Wed, no event
  assert.strictEqual(r.event, null);
  assert.ok(r.price >= 66 && r.price <= 80, `got ${r.price}`);
});

ok('weekend gets soft $99 floor on normal (non-event) Fri/Sat far out', () => {
  // 23-N normal Saturday far out, no event -> floored to 99
  const r = computeNight(config, '23-N', '2026-10-24', FAR); // Saturday, no event
  assert.strictEqual(r.event, null);
  assert.strictEqual(r.floorUsed, 99, `floorUsed ${r.floorUsed}`);
  assert.ok(r.price >= 99, `price ${r.price}`);
});

ok('Sun/Mon/Tue no soft floor, can sit near hard floor when decayed', () => {
  // Monday near date, unbooked -> decay applies, no weekend soft floor, no event
  const near = { todayYmd: '2026-10-19', isBooked: false };
  const r = computeNight(config, '23-N', '2026-10-19', near); // Monday, 0 days out
  assert.strictEqual(r.event, null);
  assert.notStrictEqual(r.floorUsed, 99); // hard floor, not soft
  assert.ok(r.price >= config.units['23-N'].floor, `price ${r.price} below hard floor`);
});

ok('Dragon Con: set price $500 1BR / $695 2BR + 5-night min', () => {
  const r4L = computeNight(config, '4-L', '2026-09-04', FAR);  // 1BR
  const r21I = computeNight(config, '21-I', '2026-09-04', FAR); // 2BR
  assert.strictEqual(r4L.minStay, 5);
  assert.strictEqual(r4L.price, 500, `1BR got ${r4L.price}`);
  assert.strictEqual(r21I.price, 695, `2BR got ${r21I.price}`);
});

ok('set-price event (Jan Atlanta Market) uses fixed $199 + 8 min', () => {
  const r = computeNight(config, '18-A', '2026-01-15', FAR);
  assert.strictEqual(r.price, 199, `got ${r.price}`);
  assert.strictEqual(r.minStay, 8);
});

ok('2027 winter market: 2BR gets $235, 1BR gets $199', () => {
  const r1 = computeNight(config, '4-L',  '2027-01-14', FAR);
  const r2 = computeNight(config, '21-I', '2027-01-14', FAR);
  assert.strictEqual(r1.price, 199);
  assert.strictEqual(r2.price, 235);
});

ok('decay: unbooked night steps down as date nears', () => {
  const farOut = computeNight(config, '4-L', '2026-10-20', { todayYmd: '2026-01-01', isBooked: false });
  const near   = computeNight(config, '4-L', '2026-10-20', { todayYmd: '2026-10-15', isBooked: false });
  assert.ok(near.price <= farOut.price, `near ${near.price} should be <= farOut ${farOut.price}`);
});

ok('booked night does NOT decay', () => {
  const r = computeNight(config, '4-L', '2026-10-20', { todayYmd: '2026-10-15', isBooked: true });
  assert.strictEqual(r.layers.decay, 'skipped(booked)');
});

ok('never below hard floor', () => {
  // force a deep-decay aggressive low day
  const r = computeNight(config, '23-N', '2026-09-08', { todayYmd: '2026-09-07', isBooked: false }); // Tue after Dragon Con
  assert.ok(r.price >= config.units['23-N'].floor, `price ${r.price} < floor ${config.units['23-N'].floor}`);
});

ok('never above ceiling', () => {
  for (const u of Object.keys(config.units)) {
    const r = computeNight(config, u, '2026-09-04', FAR); // Dragon Con high day
    assert.ok(r.price <= config.units[u].ceiling, `${u} ${r.price} > ceiling ${config.units[u].ceiling}`);
  }
});

ok('min-stay decay: [4,3] gives 4 far out, 3 near', () => {
  assert.strictEqual(resolveMinStay([4,3], 40), 4);
  assert.strictEqual(resolveMinStay([4,3], 5), 3);
});

console.log(`\n${pass} passed`);
