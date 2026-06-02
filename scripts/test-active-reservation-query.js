// TDD for the getActiveReservation query: it must use only Hospitable-valid
// reservation statuses. 'checked_in' is NOT valid and returns HTTP 400, which
// made the lookup fail → concierge email showed N/A check-in/out.
// Run: node scripts/test-active-reservation-query.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// Hospitable's documented valid status values (from the 400 error body).
const VALID = ['not_accepted', 'request', 'accepted', 'cancelled', 'checkpoint'];

// Extract the pure path builder from source (no server boot).
const m = src.match(/function buildActiveReservationPath\([\s\S]*?\n}/);
assert.ok(m, 'buildActiveReservationPath() not found in server.js');
eval(m[0]);

let pass = 0;
const check = (n, f) => { f(); console.log('✓', n); pass++; };

const url = buildActiveReservationPath('PID-123');

check('query never sends the invalid status "checked_in"', () => {
  assert.ok(!url.includes('checked_in'), `query still contains checked_in: ${url}`);
});
check('query includes the valid "accepted" status', () => {
  assert.ok(url.includes('status[]=accepted'));
});
check('every status[] value is in Hospitable\'s valid set', () => {
  const statuses = [...url.matchAll(/status\[\]=([a-z_]+)/g)].map(x => x[1]);
  assert.ok(statuses.length > 0, 'no status filter present');
  for (const s of statuses) assert.ok(VALID.includes(s), `invalid status: ${s}`);
});
check('query still targets the property and includes guest', () => {
  assert.ok(url.includes('properties[]=PID-123'));
  assert.ok(url.includes('include=guest'));
});
check('regression control: the OLD query string would FAIL this (had checked_in)', () => {
  const old = `/reservations?properties[]=PID-123&status[]=accepted&status[]=checked_in&per_page=5&include=guest`;
  assert.ok(old.includes('checked_in')); // documents the bug we removed
});

console.log(`\nRESULT: ${pass}/5 passed`);
