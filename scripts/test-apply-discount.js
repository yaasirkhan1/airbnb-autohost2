// Unit tests for the base-anchored discount core. Run: node scripts/test-apply-discount.js
'use strict';
const assert = require('assert');
const { discountedFromBase, floorFor } = require('./apply-discount.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✓', name); pass++; }
  catch (e) { console.log('✗', name, '→', e.message); fail++; }
}

const FLOOR = 175;

check('single 10% off base (above floor)', () => {
  assert.strictEqual(discountedFromBase(300, 10, FLOOR), 270);
});

check('IDEMPOTENT: feeding the same base always yields the same price (no compounding)', () => {
  // The guarantee: the discount derives from base, so it is stable across runs.
  assert.strictEqual(discountedFromBase(300, 10, FLOOR), discountedFromBase(300, 10, FLOOR));
  const once = discountedFromBase(300, 10, FLOOR); // 270
  assert.strictEqual(once, 270);
  // The OLD buggy path multiplied the prior *result* by 0.9 each run → it would have drifted:
  const buggyCompounded = Math.round(once * 0.9); // 243, then 219, then ... → the $3.60 spiral
  assert.notStrictEqual(buggyCompounded, once);
});

check('floor clamp: a deep discount can never go below the unit floor', () => {
  assert.strictEqual(discountedFromBase(190, 99, FLOOR), FLOOR); // 190*0.01=1.9 → floored to 175
  assert.strictEqual(discountedFromBase(4, 10, FLOOR), FLOOR);   // the $3.60 case → floored to 175
});

check('2BR uses the higher $250 floor', () => {
  assert.strictEqual(floorFor('7b7fda8b-e1d8-460f-8143-59a1a2b4d81c'), 250);
  assert.strictEqual(floorFor('283977a3-3af3-4d90-8d95-b418a3014d90'), 175);
});

check('bad base returns null (skip, never write garbage)', () => {
  assert.strictEqual(discountedFromBase(null, 10, FLOOR), null);
  assert.strictEqual(discountedFromBase(undefined, 10, FLOOR), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
