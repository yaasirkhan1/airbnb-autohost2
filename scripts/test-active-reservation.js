// TDD for getActiveReservation's date logic (server.js). "today" must be the
// America/New_York calendar date; UTC shifts the active window forward in the ET
// evening, conflating tonight's guest with a turnover-day arrival.
// Run: node scripts/test-active-reservation.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { dateInTimeZone } = require('../src/cleaning-schedule');

// Extract the pure findActiveReservation() from source (no server boot).
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const m = src.match(/function findActiveReservation\([\s\S]*?\n}/);
assert.ok(m, 'findActiveReservation() not found in server.js');
eval(m[0]);

// tonight's guest checks out 06-02; a different guest arrives 06-02 (turnover)
const RES = [
  { id: 'current',  check_in: '2026-05-30', check_out: '2026-06-02' },
  { id: 'arriving', check_in: '2026-06-02', check_out: '2026-06-06' },
];
const matches = (res, today) => res.filter(r =>
  r.check_in.slice(0, 10) <= today && r.check_out.slice(0, 10) >= today).map(r => r.id);
const EVENING = new Date('2026-06-02T01:00:00Z'); // 9:00 PM EDT Jun 1

let pass = 0;
const check = (n, f) => { f(); console.log('✓', n); pass++; };

check('evening-ET run resolves today = 2026-06-01 (ET), not UTC 2026-06-02', () => {
  assert.strictEqual(dateInTimeZone(EVENING, 'America/New_York'), '2026-06-01');
});
check('ET today → exactly ONE active reservation (tonight\'s guest)', () => {
  assert.deepStrictEqual(matches(RES, '2026-06-01'), ['current']);
  assert.strictEqual(findActiveReservation(RES, '2026-06-01').id, 'current');
});
check('BUG: UTC today (06-02) shifts window to the turnover day → 2 match (ambiguous)', () => {
  assert.deepStrictEqual(matches(RES, '2026-06-02').sort(), ['arriving', 'current']);
});
check('BUG: with arriving-guest listed first, UTC today picks the NOT-yet-arrived guest', () => {
  const reordered = [RES[1], RES[0]];
  assert.strictEqual(findActiveReservation(reordered, '2026-06-02').id, 'arriving'); // wrong
  assert.strictEqual(findActiveReservation(reordered, '2026-06-01').id, 'current');  // ET fix → correct
});
check('END-TO-END: at 9PM ET, fixed today → tonight\'s guest, not the arrival', () => {
  const today = dateInTimeZone(EVENING, 'America/New_York');
  assert.strictEqual(findActiveReservation([RES[1], RES[0]], today).id, 'current');
});

console.log(`\nRESULT: ${pass}/5 passed`);
