// Tests for the vacancy-decay core: the ratchet step, the floor, and the date-scoped,
// self-lifting fence. Pure + deterministic. Run: node scripts/test-pricing-decay.js
'use strict';
const assert = require('assert');
const { decayStep, isDecayFenced, decayCampaignFor, DECAY_CAMPAIGNS } = require('../src/pricing-decay');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '→', e.message); fail++; } };

const C = { step: 1, floor: 99 };

check('one step drops the live price by exactly $step', () => {
  assert.strictEqual(decayStep(121, C), 120);
  assert.strictEqual(decayStep(167, C), 166);
});

check('RATCHET: repeated steps accumulate downward (not sawtooth)', () => {
  let p = 121;
  for (let i = 0; i < 5; i++) p = decayStep(p, C); // 5 pushes
  assert.strictEqual(p, 116, `5 pushes from 121 → ${p}`);
});

check('floor clamps and never goes below', () => {
  assert.strictEqual(decayStep(100, C), 99);
  assert.strictEqual(decayStep(99, C), 99);   // already at floor → no-op
  assert.strictEqual(decayStep(99.4, C), 99); // rounding, still floored
});

check('never produces a sub-floor price; runner pushes only when it lowers (next < cur)', () => {
  assert.strictEqual(decayStep(99, C), 99);    // at floor → returns floor (runner sees next>=cur → skip)
  assert.strictEqual(decayStep(120, C), 119);  // above floor → lowers by step (runner pushes)
  // A stray sub-floor price returns the floor (never lower); the runner's next<cur guard
  // (99 >= 80) means it is NOT pushed, so the night is left alone — no upward correction.
  assert.strictEqual(decayStep(80, C), 99);
  assert.ok(decayStep(80, C) >= 99, 'never below floor');
});

check('non-numeric current price → null (caller leaves the night alone)', () => {
  assert.strictEqual(decayStep(null, C), null);
  assert.strictEqual(decayStep(undefined, C), null);
  assert.strictEqual(decayStep('x', C), null);
});

// ── Fence: date-scoped + self-lifting ───────────────────────────────────────────────
check('fence covers the configured units across the whole inclusive window', () => {
  assert.ok(isDecayFenced('4-L', '2026-06-07'));  // start (inclusive)
  assert.ok(isDecayFenced('4-L', '2026-06-13'));  // end (inclusive)
  assert.ok(isDecayFenced('24-L', '2026-06-10')); // mid-window
  assert.ok(isDecayFenced('18-A', '2026-06-12')); // 18-A now fenced too
});

check('fence does NOT cover other units, or dates outside the window (self-lifting)', () => {
  assert.ok(!isDecayFenced('21-I', '2026-06-10'), 'only 4-L/24-L/18-A are fenced');
  assert.ok(!isDecayFenced('4-L', '2026-06-06'), 'day before window');
  assert.ok(!isDecayFenced('4-L', '2026-06-14'), 'day AFTER window → engine resumes (Jun 14+ untouched)');
  assert.ok(!isDecayFenced('18-A', '2026-06-14'), '18-A also self-lifts on Jun 14');
  assert.ok(!isDecayFenced('4-L', '2026-07-01'), 'well after window');
});

check('campaign params match the agreed config (units, dates, step $1, floor $99)', () => {
  const c = decayCampaignFor('4-L', '2026-06-13');
  assert.deepStrictEqual(c.units.sort(), ['18-A', '24-L', '4-L']);
  assert.strictEqual(c.start, '2026-06-07');
  assert.strictEqual(c.end, '2026-06-13');
  assert.strictEqual(c.step, 1);
  assert.strictEqual(c.floor, 99);
  assert.strictEqual(DECAY_CAMPAIGNS.length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
