// TDD for the cleaning-schedule date logic (timezone correctness) + unit
// selection, using tonight's REAL calendar data (2026-06-01/02/03).
// Run: node scripts/test-cleaning-schedule.js
const assert = require('assert');
const { tomorrowInTZ, needsCleaning, dateOffset } = require('../src/cleaning-schedule');

let pass = 0;
const check = (name, fn) => { fn(); console.log('✓', name); pass++; };

// ── Date logic: "tomorrow" must be computed in America/New_York, not UTC ──
check('9PM ET cron (01:00 UTC next day) → tomorrow is 2026-06-02, NOT 06-03', () => {
  // 9:00 PM EDT on Jun 1 == 2026-06-02T01:00:00Z
  assert.strictEqual(tomorrowInTZ(new Date('2026-06-02T01:00:00Z'), 'America/New_York'), '2026-06-02');
});
check('late-evening ET (11:30 PM) still → next calendar day in ET', () => {
  assert.strictEqual(tomorrowInTZ(new Date('2026-06-02T03:30:00Z'), 'America/New_York'), '2026-06-02');
});
check('daytime run → same correct answer', () => {
  assert.strictEqual(tomorrowInTZ(new Date('2026-06-01T14:00:00Z'), 'America/New_York'), '2026-06-02');
});
check('regression control: the OLD UTC logic produced 06-03 at the 9PM-ET instant', () => {
  const d = new Date('2026-06-02T01:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  assert.strictEqual(d.toISOString().slice(0, 10), '2026-06-03'); // the bug
});

// ── Unit selection on tonight's REAL calendar data ──
// Per unit: prior-night reason + target-day availability, captured live tonight.
//   needsCleaning = prior reason RESERVED AND target available !== false
const CAL = {
  '4-L':  { '2026-06-01': { status: { reason: 'RESERVED'  } }, '2026-06-02': { status: { reason: 'AVAILABLE', available: true  } }, '2026-06-03': { status: { available: true  } } },
  '7-B':  { '2026-06-01': { status: { reason: 'RESERVED'  } }, '2026-06-02': { status: { reason: 'AVAILABLE', available: true  } }, '2026-06-03': { status: { available: true  } } },
  '21-I': { '2026-06-01': { status: { reason: 'RESERVED'  } }, '2026-06-02': { status: { reason: 'RESERVED',  available: false } }, '2026-06-03': { status: { available: true  } } },
  '24-L': { '2026-06-01': { status: { reason: 'RESERVED'  } }, '2026-06-02': { status: { reason: 'RESERVED',  available: false } }, '2026-06-03': { status: { available: true  } } },
  '18-A': { '2026-06-01': { status: { reason: 'RESERVED'  } }, '2026-06-02': { status: { reason: 'RESERVED',  available: false } }, '2026-06-03': { status: { available: false } } },
  '21-D': { '2026-06-01': { status: { reason: 'BLOCKED'   } }, '2026-06-02': { status: { reason: 'BLOCKED',   available: false } }, '2026-06-03': { status: { available: false } } },
  '23-N': { '2026-06-01': { status: { reason: 'AVAILABLE' } }, '2026-06-02': { status: { reason: 'AVAILABLE', available: true  } }, '2026-06-03': { status: { available: true  } } },
};
const selectUnits = (target) => Object.keys(CAL)
  .filter(u => needsCleaning(CAL[u][dateOffset(target, -1)], CAL[u][target]))
  .sort();

check('CORRECT day (2026-06-02) → cleans 4-L and 7-B', () => {
  assert.deepStrictEqual(selectUnits('2026-06-02'), ['4-L', '7-B']);
});
check('run targeting 2026-06-03 still correctly selects 24-L & 21-I (per-date logic is right)', () => {
  assert.deepStrictEqual(selectUnits('2026-06-03'), ['21-I', '24-L']);
});
check('END-TO-END: agent at 9PM ET tonight now selects 4-L & 7-B, NOT 24-L & 21-I', () => {
  const target = tomorrowInTZ(new Date('2026-06-02T01:00:00Z'), 'America/New_York');
  const units = selectUnits(target);
  assert.deepStrictEqual(units, ['4-L', '7-B']);
  assert.ok(!units.includes('24-L') && !units.includes('21-I'), 'must NOT include the June-3 units');
});

console.log(`\nRESULT: ${pass}/7 passed`);
