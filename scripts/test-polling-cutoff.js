// TDD for the pollingSince "too old" guard (server.js:487). msg.created_at is
// ISO ("…T…Z"); pollingSince is PHP "Y-m-d H:i:s" (UTC). A raw string compare is
// wrong (T 0x54 > space 0x20). Compare numerically via tsMs().
// Run: node scripts/test-polling-cutoff.js
const assert = require('assert');
const { tsMs } = require('../src/seen-store');

// mirrors the fixed guard: skip messages strictly older than the cutoff
const isTooOld = (createdAt, pollingSince) => tsMs(createdAt) < tsMs(pollingSince);

const SINCE = '2026-06-01 21:55:00'; // PHP "Y-m-d H:i:s" UTC (as toHospitableDate produces)

let pass = 0;
const check = (n, f) => { f(); console.log('✓', n); pass++; };

check('same-day message 5 min BEFORE cutoff → skipped (too old)', () => {
  assert.strictEqual(isTooOld('2026-06-01T21:50:00Z', SINCE), true);
});
check('same-day message AFTER cutoff → NOT skipped', () => {
  assert.strictEqual(isTooOld('2026-06-01T21:58:00Z', SINCE), false);
});
check('message exactly at cutoff → NOT skipped (not strictly older)', () => {
  assert.strictEqual(isTooOld('2026-06-01T21:55:00Z', SINCE), false);
});
check('clearly older date → skipped', () => {
  assert.strictEqual(isTooOld('2026-05-25T10:00:00Z', SINCE), true);
});
check('handles +00:00 offset form of created_at', () => {
  assert.strictEqual(isTooOld('2026-06-01T21:50:00+00:00', SINCE), true);
});
check('regression control: raw STRING compare wrongly keeps a same-day-older msg', () => {
  // 'T'(0x54) > ' '(0x20) at index 10 → created_at sorts AFTER since → guard never fires
  assert.strictEqual('2026-06-01T21:50:00Z' < SINCE, false); // the bug
});

console.log(`\nRESULT: ${pass}/6 passed`);
