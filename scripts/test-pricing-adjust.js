// Tests for manual % price adjustment: the percentage math, floor/ceiling clamps, booked/no-price
// skips, and the reversible snapshot. Pure logic — no I/O. Run: node scripts/test-pricing-adjust.js
'use strict';
const assert = require('assert');
const A = require('../src/pricing-adjust');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };
const BOUNDS = { floor: 72, ceiling: 799 };

check('adjustPrice lowers/raises by signed percentage (rounded)', () => {
  assert.deepStrictEqual(A.adjustPrice(200, -5, BOUNDS), { price: 190, bound: null });
  assert.deepStrictEqual(A.adjustPrice(200, 10, BOUNDS), { price: 220, bound: null });
  assert.strictEqual(A.adjustPrice(199, -5, BOUNDS).price, 189); // 189.05 → 189
});

check('adjustPrice clamps to floor and ceiling (clamp is visible)', () => {
  assert.deepStrictEqual(A.adjustPrice(75, -50, BOUNDS), { price: 72, bound: 'floor' });
  assert.deepStrictEqual(A.adjustPrice(780, 10, BOUNDS), { price: 799, bound: 'ceiling' });
});

check('buildAdjustRows skips booked + no-price + unchanged nights, snapshots the rest', () => {
  const entries = [
    { date: '2026-06-20', current: 200, booked: false },
    { date: '2026-06-21', current: 200, booked: true  },   // booked → skip
    { date: '2026-06-22', current: null, booked: false },  // no price → skip
    { date: '2026-06-23', current: 73,  booked: false },   // -5% = 69 → clamps to 72
  ];
  const { rows, snapshot, skipped } = A.buildAdjustRows(entries, -5, BOUNDS);
  assert.deepStrictEqual(rows.map(r => [r.date, r.from, r.to]), [['2026-06-20', 200, 190], ['2026-06-23', 73, 72]]);
  assert.deepStrictEqual(snapshot, [{ date: '2026-06-20', price: 200 }, { date: '2026-06-23', price: 73 }]);
  assert.deepStrictEqual(skipped.map(s => s.reason).sort(), ['booked', 'no_price']);
  assert.strictEqual(rows[1].bound, 'floor');
});

check('snapshot is the revert source (from-values restore the originals)', () => {
  const entries = [{ date: '2026-06-20', current: 200, booked: false }];
  const { snapshot } = A.buildAdjustRows(entries, -5, BOUNDS);
  // Reverting = pushing the snapshot prices back.
  assert.deepStrictEqual(snapshot, [{ date: '2026-06-20', price: 200 }]);
});

check('dateRange is inclusive', () => {
  assert.deepStrictEqual(A.dateRange('2026-06-20', '2026-06-23'), ['2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23']);
});

check('recordAdjustment prepends and caps history at 50', () => {
  let store = [];
  for (let i = 0; i < 55; i++) store = A.recordAdjustment(store, { id: `a${i}`, pct: -5, start: 'x', end: 'y', units: [] });
  assert.strictEqual(store.length, 50);
  assert.strictEqual(store[0].id, 'a54'); // most recent first
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
