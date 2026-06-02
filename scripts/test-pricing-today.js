// TDD: pricing "today" must be the America/New_York calendar date, so the
// countdown (days-out) is identical whether the tool runs at 10am or 9pm ET.
// Run: node scripts/test-pricing-today.js
const assert = require('assert');
const { todayET, daysBetween, computeTarget } = require('./set-pricing.js');
const cal = require('../config/pricing-calendar.json');

const EVENING = new Date('2026-06-02T01:00:00Z'); // 9:00 PM EDT Jun 1 (UTC already Jun 2)
const MORNING = new Date('2026-06-01T14:00:00Z'); // 10:00 AM EDT Jun 1

let pass = 0;
const check = (n, f) => { f(); console.log('✓', n); pass++; };

check('evening-ET run resolves today = 2026-06-01 (ET), not UTC 2026-06-02', () => {
  assert.strictEqual(todayET(EVENING), '2026-06-01');
});
check('10am-ET run resolves the same ET date', () => {
  assert.strictEqual(todayET(MORNING), '2026-06-01');
});
check('evening and morning runs agree on "today"', () => {
  assert.strictEqual(todayET(EVENING), todayET(MORNING));
});
check('=> identical day-out math for a target date (countdown unaffected by run time)', () => {
  const target = '2026-09-04';
  assert.strictEqual(daysBetween(todayET(EVENING), target), daysBetween(todayET(MORNING), target));
});
check('=> identical computed tier/price regardless of run time', () => {
  const base = { date: '2026-08-15', group: 'older_1br', cal, overrides: {} };
  const ev = computeTarget({ ...base, today: todayET(EVENING) });
  const mo = computeTarget({ ...base, today: todayET(MORNING) });
  assert.deepStrictEqual(ev, mo);
});
check('regression control: OLD UTC logic gave 2026-06-02 on the evening run (the bug)', () => {
  assert.strictEqual(new Date('2026-06-02T01:00:00Z').toISOString().slice(0, 10), '2026-06-02');
});

console.log(`\nRESULT: ${pass}/6 passed`);
