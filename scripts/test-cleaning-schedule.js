// Tests for the cleaning-schedule logic. Run: node scripts/test-cleaning-schedule.js
//   1) date logic (the 9PM-ET-vs-UTC timezone fix)
//   2) turnover classification — cleaning is driven by a CHECKOUT on the target date;
//      a same-day turnover (checkout + check-in) is HIGHEST priority, never a skip
//   3) active-reservation filtering (cancelled/declined never trigger a cleaning)
const assert = require('assert');
const { tomorrowInTZ, dateOffset, isActiveReservation, classifyTurnover } = require('../src/cleaning-schedule');

let pass = 0;
const check = (name, fn) => { fn(); console.log('✓', name); pass++; };

// ── Date logic: "tomorrow" must be computed in America/New_York, not UTC ──
check('9PM ET cron (01:00 UTC next day) → tomorrow is 2026-06-02, NOT 06-03', () => {
  assert.strictEqual(tomorrowInTZ(new Date('2026-06-02T01:00:00Z'), 'America/New_York'), '2026-06-02');
});
check('late-evening ET (11:30 PM) still → next calendar day in ET', () => {
  assert.strictEqual(tomorrowInTZ(new Date('2026-06-02T03:30:00Z'), 'America/New_York'), '2026-06-02');
});
check('daytime run → same correct answer', () => {
  assert.strictEqual(tomorrowInTZ(new Date('2026-06-01T14:00:00Z'), 'America/New_York'), '2026-06-02');
});

// ── classifyTurnover: a CHECKOUT drives cleaning; a same-day check-in raises priority ──
check('same-day TURNOVER detected (checkout + check-in same date) → needsCleaning + priority', () => {
  const r = classifyTurnover([{ id: 'out' }], [{ id: 'in' }]);
  assert.strictEqual(r.needsCleaning, true);
  assert.strictEqual(r.sameDayTurnover, true);
});
check('checkout-to-EMPTY detected (checkout, no check-in) → needsCleaning, NOT priority', () => {
  const r = classifyTurnover([{ id: 'out' }], []);
  assert.strictEqual(r.needsCleaning, true);
  assert.strictEqual(r.sameDayTurnover, false);
});
check('continuing stay correctly SKIPPED (no checkout on target) → no cleaning', () => {
  const r = classifyTurnover([], []);              // multi-night guest, no checkout today
  assert.strictEqual(r.needsCleaning, false);
  assert.strictEqual(r.sameDayTurnover, false);
});
check('check-in only with NO checkout (arrival into vacant/blocked unit) → no cleaning', () => {
  const r = classifyTurnover([], [{ id: 'in' }]);
  assert.strictEqual(r.needsCleaning, false);
});

// ── isActiveReservation: only real stays count ──
check('accepted/checked_out/unknown count as active; cancelled/declined/etc. do not', () => {
  assert.strictEqual(isActiveReservation({ status: 'accepted' }), true);
  assert.strictEqual(isActiveReservation({ status: 'checked_out' }), true);
  assert.strictEqual(isActiveReservation({ status: 'CONFIRMED' }), true);        // case-insensitive
  assert.strictEqual(isActiveReservation({ status: 'weird_new_status' }), true); // denylist → bias to flag
  assert.strictEqual(isActiveReservation({ status: 'cancelled' }), false);
  assert.strictEqual(isActiveReservation({ status: 'declined' }), false);
  assert.strictEqual(isActiveReservation({ status: 'request' }), false);
});

// ── Pipeline replica on Jun-5-shaped data (active filter + field extraction + classify) ──
// Mirrors getReservationsForDate's split so the decision is tested end-to-end on real shapes.
const co = r => (r.check_out || r.checkout || '').slice(0, 10);
const ci = r => (r.check_in  || r.checkin  || '').slice(0, 10);
function decide(reservations, target) {
  const active   = reservations.filter(isActiveReservation);
  const outgoing = active.filter(r => co(r) === target);
  const incoming = active.filter(r => ci(r) === target);
  return classifyTurnover(outgoing, incoming);
}

check('4-L Jun 5 (accepted checkout 06-05 + accepted check-in 06-05) → TURNOVER (was wrongly skipped)', () => {
  const RES = [
    { status: 'accepted',  check_in: '2026-06-04', check_out: '2026-06-05' }, // departing
    { status: 'accepted',  check_in: '2026-06-05', check_out: '2026-06-07' }, // arriving
    { status: 'cancelled', check_in: '2026-06-05', check_out: '2026-06-14' }, // noise — must be ignored
  ];
  const r = decide(RES, '2026-06-05');
  assert.strictEqual(r.needsCleaning, true);
  assert.strictEqual(r.sameDayTurnover, true);
});
check('24-L Jun 5 (accepted 06-01→06-05 out + accepted 06-05→06-07 in) → TURNOVER', () => {
  const RES = [
    { status: 'accepted',  check_in: '2026-06-01', check_out: '2026-06-05' },
    { status: 'accepted',  check_in: '2026-06-05', check_out: '2026-06-07' },
    { status: 'cancelled', check_in: '2026-06-05', check_out: '2026-06-07' },
  ];
  const r = decide(RES, '2026-06-05');
  assert.strictEqual(r.sameDayTurnover, true);
});
check('21-I Jun 5 (single accepted 06-04→06-07 continuing stay) → correctly SKIPPED', () => {
  const RES = [
    { status: 'accepted',  check_in: '2026-06-04', check_out: '2026-06-07' }, // spans Jun 5, no checkout
    { status: 'cancelled', check_in: '2026-06-05', check_out: '2026-06-07' },
  ];
  const r = decide(RES, '2026-06-05');
  assert.strictEqual(r.needsCleaning, false);
});

console.log(`\nRESULT: ${pass}/${pass} passed`);
