// Tests for the World Cup fill campaign core: labels, weekend floor uplift, the −7% seed
// (never raises, never below floor), the proximity decay step, and the self-lifting fence.
'use strict';
const assert = require('assert');
const W = require('../src/wc-fill');
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); console.log('✓ ' + name); pass++; } catch (e) { console.log('✗ ' + name + ' — ' + e.message); fail++; } };

check('labels: game / shoulder (±1 of a game) / base', () => {
  assert.strictEqual(W.wcLabel('2026-06-21'), 'game');     // game day
  assert.strictEqual(W.wcLabel('2026-06-20'), 'shoulder'); // day before a game
  assert.strictEqual(W.wcLabel('2026-06-22'), 'shoulder'); // day after a game
  assert.strictEqual(W.wcLabel('2026-06-26'), 'base');     // not adjacent to any game
});

check('weekend = Fri/Sat/Sun only', () => {
  assert.ok(W.isWeekend('2026-06-19') && W.isWeekend('2026-06-20') && W.isWeekend('2026-06-21')); // Fri/Sat/Sun
  assert.ok(!W.isWeekend('2026-06-22') && !W.isWeekend('2026-06-18')); // Mon / Thu
});

check('floors: tier values, +15% weekend uplift (rounded)', () => {
  assert.strictEqual(W.wcFloor('1BR', '2026-06-22'), 114); // weekday shoulder
  assert.strictEqual(W.wcFloor('1BR', '2026-06-24'), 124); // weekday game
  assert.strictEqual(W.wcFloor('1BR', '2026-06-20'), 131); // weekend shoulder 114*1.15
  assert.strictEqual(W.wcFloor('1BR', '2026-06-21'), 143); // weekend game 124*1.15
  assert.strictEqual(W.wcFloor('1BR', '2026-06-26'), 114); // weekend base 99*1.15
  assert.strictEqual(W.wcFloor('2BR', '2026-06-22'), 148); // weekday shoulder
  assert.strictEqual(W.wcFloor('2BR', '2026-06-21'), 185); // weekend game 161*1.15
  assert.strictEqual(W.wcFloor('2BR', '2026-06-26'), 148); // weekend base 129*1.15
});

check('seed = current−7%, clamped >= floor, NEVER above current', () => {
  assert.strictEqual(W.wcSeed(167, '1BR', '2026-06-22'), 155); // 167*.93=155.3 -> 155, > floor 114
  assert.strictEqual(W.wcSeed(176, '1BR', '2026-06-24'), 164); // game weekday
  assert.strictEqual(W.wcSeed(225, '2BR', '2026-06-16'), 209); // 225*.93=209.25 -> 209
  // Jun 14 1BR: current 111, weekend-shoulder floor 131 (>current) → never raised, holds 111
  assert.strictEqual(W.wcSeed(111, '1BR', '2026-06-14'), 111);
});

check('decay step: -$1/push <=10d (=-$3/day); 11-20d -$2/day via 2 slots; floor clamp; never raise', () => {
  // 6 days out (<=10): every slot drops $1
  assert.strictEqual(W.wcDecayTarget(155, '1BR', '2026-06-22', 6, 9), 154);  // 9am slot
  assert.strictEqual(W.wcDecayTarget(155, '1BR', '2026-06-22', 6, 19), 154); // 7pm slot also drops
  // 15 days out (11-20): drops at 9am & 3pm slots, NOT 7pm
  assert.strictEqual(W.wcDecayTarget(155, '1BR', '2026-06-22', 15, 9), 154);
  assert.strictEqual(W.wcDecayTarget(155, '1BR', '2026-06-22', 15, 19), 155); // 7pm: no drop
  // floor clamp: at floor, stays at floor (never below)
  assert.strictEqual(W.wcDecayTarget(114, '1BR', '2026-06-22', 6, 9), 114);
  assert.strictEqual(W.wcDecayTarget(99, '2BR', '2026-06-22', 6, 9) >= W.wcFloor('2BR','2026-06-22'), true);
});

check('fence covers Jun 14–26, self-lifts outside (and respects kill switch)', () => {
  assert.ok(W.wcFenced('2026-06-14') && W.wcFenced('2026-06-26')); // inclusive ends
  assert.ok(!W.wcFenced('2026-06-13') && !W.wcFenced('2026-06-27')); // outside window
  assert.ok(!W.wcFenced('2026-06-20', { WC_FILL_OFF: '1' })); // kill switch off
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
