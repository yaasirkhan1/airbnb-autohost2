// Deterministic unit tests for the pricing engine's pure decision function and
// safety rails. Run: node scripts/test-pricing-engine.js
const assert = require('assert');
const path = require('path');
const { computeTarget } = require('./set-pricing.js');
const cal = require('../config/pricing-calendar.json');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✓', name); pass++; }
  catch (e) { console.log('✗', name, '→', e.message); fail++; }
}
const T = (date, group, opts = {}) =>
  computeTarget({ date, group, today: opts.today || '2026-06-01', cal, overrides: opts.overrides || {} });

// ── Rails: blackout ──────────────────────────────────────────────────────────
check('blackout date is skipped (absolute)', () => {
  const r = T('2026-06-20', 'older_1br');
  assert.strictEqual(r.action, 'skip');
  assert.match(r.reason, /blackout/);
});

// ── Base tiers, far out (hold bucket) ────────────────────────────────────────
check('weekday normal → $85 older_1br', () => {
  const r = T('2026-08-10', 'older_1br'); // Monday
  assert.strictEqual(r.action, 'set'); assert.strictEqual(r.price, 85); assert.strictEqual(r.min_stay, 1);
});
check('Saturday hits weekend floor $99 older_1br', () => {
  const r = T('2026-08-08', 'older_1br'); // Saturday
  assert.strictEqual(r.price, 99); assert.strictEqual(r.min_stay, 2);
});
check('premium weekend floor $119', () => {
  assert.strictEqual(T('2026-08-08', 'premium_1br').price, 119);
});

// ── Event override: Dragon Con ───────────────────────────────────────────────
check('Dragon Con 1BR → $500 / 5-night', () => {
  const r = T('2026-09-04', 'older_1br');
  assert.strictEqual(r.price, 500); assert.strictEqual(r.min_stay, 5);
});
check('Dragon Con 2BR → $688 / 5-night', () => {
  assert.strictEqual(T('2026-09-04', 'twobr').price, 688);
});

// ── Countdown: open weekday near date → floor; weekend never below $99 ────────
check('open weekday 10 days out → $75 floor', () => {
  const r = T('2026-08-11', 'older_1br', { today: '2026-08-01' }); // Tue, 10 days out
  assert.strictEqual(r.price, 75);
});
check('open weekend 5 days out → still $99 weekend floor', () => {
  const r = T('2026-08-08', 'older_1br', { today: '2026-08-03' }); // Sat, 5 days out
  assert.strictEqual(r.price, 99);
});

// ── Manual override file: priority, but rails absolute ───────────────────────
check('override within range is used', () => {
  const r = T('2026-08-10', 'older_1br', { overrides: { '2026-08-10': { price: 140, min_stay: 3 } } });
  assert.strictEqual(r.price, 140); assert.strictEqual(r.min_stay, 3); assert.strictEqual(r.source, 'manual-override-file');
});
check('override below $75 floor → ABORT', () => {
  const r = T('2026-08-10', 'older_1br', { overrides: { '2026-08-10': { price: 50 } } });
  assert.strictEqual(r.action, 'abort');
});
check('override above $700 ceiling → ABORT', () => {
  const r = T('2026-08-10', 'older_1br', { overrides: { '2026-08-10': { price: 800 } } });
  assert.strictEqual(r.action, 'abort');
});
check('override cannot place price in blackout (blackout wins, skip)', () => {
  const r = T('2026-06-20', 'older_1br', { overrides: { '2026-06-20': { price: 200 } } });
  assert.strictEqual(r.action, 'skip'); // blackout checked before overrides
});

// ── Outside window ───────────────────────────────────────────────────────────
check('date after window end is skipped', () => {
  assert.strictEqual(T('2027-07-01', 'older_1br').action, 'skip');
});

console.log(`\nRESULT: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
