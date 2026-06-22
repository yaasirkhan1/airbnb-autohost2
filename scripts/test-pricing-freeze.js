// Tests for the manual decay-freeze window: set/clear, the rolling [today, today+N] predicate, and
// the sanity cap. Pure logic — no I/O. Run: node scripts/test-pricing-freeze.js
'use strict';
const assert = require('assert');
const F = require('../src/pricing-freeze');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

check('setFreeze builds a {days,setAt} store and rejects bad N', () => {
  const s = F.setFreeze(7, new Date('2026-06-22T12:00:00Z'));
  assert.strictEqual(s.days, 7);
  assert.ok(s.setAt.startsWith('2026-06-22'));
  assert.throws(() => F.setFreeze(0));
  assert.throws(() => F.setFreeze(61));
  assert.throws(() => F.setFreeze(3.5));
});

check('isManualFreeze is true only inside [today, today+N]', () => {
  const store = F.setFreeze(7, new Date('2026-06-22T12:00:00Z'));
  const today = '2026-06-22';
  assert.strictEqual(F.isManualFreeze('2026-06-22', today, store), true);  // today
  assert.strictEqual(F.isManualFreeze('2026-06-29', today, store), true);  // edge (today+7)
  assert.strictEqual(F.isManualFreeze('2026-06-30', today, store), false); // just past window
  assert.strictEqual(F.isManualFreeze('2026-06-21', today, store), false); // before today
});

check('clearFreeze / empty store → never frozen', () => {
  assert.strictEqual(F.isManualFreeze('2026-06-23', '2026-06-22', F.clearFreeze()), false);
  assert.strictEqual(F.isManualFreeze('2026-06-23', '2026-06-22', {}), false);
});

check('freezeWindow rolls forward with today and is null when off', () => {
  const store = F.setFreeze(5, new Date('2026-06-22T00:00:00Z'));
  assert.deepStrictEqual(F.freezeWindow('2026-06-25', store), { start: '2026-06-25', end: '2026-06-30' });
  assert.strictEqual(F.freezeWindow('2026-06-25', {}), null);
});

check('addDays handles month rollover', () => {
  assert.strictEqual(F.addDays('2026-06-29', 3), '2026-07-02');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
